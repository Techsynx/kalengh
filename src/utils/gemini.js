const { GoogleGenAI, Modality } = require('@google/genai');
const { BrowserWindow, ipcMain } = require('electron');
const { spawn } = require('child_process');
const { saveDebugAudio } = require('../audioUtils');
const { getSystemPrompt } = require('./prompts');
const {
    getAvailableModel,
    incrementLimitCount,
    getApiKey,
    getGroqApiKey,
    getGroqApiKeys,
    incrementCharUsage,
    getModelForToday,
} = require('../storage');
const { connectCloud, sendCloudAudio, sendCloudText, sendCloudImage, closeCloud, isCloudActive, setOnTurnComplete } = require('./cloud');

// Lazy-loaded to avoid circular dependency (localai.js imports from gemini.js)
let _localai = null;
function getLocalAi() {
    if (!_localai) _localai = require('./localai');
    return _localai;
}

// Provider mode: 'byok', 'cloud', or 'local'
let currentProviderMode = 'byok';

// Groq conversation history for context
let groqConversationHistory = [];

// Conversation tracking variables
let currentSessionId = null;
let currentTranscription = '';
let conversationHistory = [];
let screenAnalysisHistory = [];
let currentProfile = null;
let currentCustomPrompt = null;
let isInitializingSession = false;
let currentSystemPrompt = null;
let lastTargetRole = null;
let lastTargetTechStack = null;

function ensureSystemPrompt() {
    return refreshSystemPrompt();
}

function refreshSystemPrompt(profileOverride, customPromptOverride) {
    try {
        const storage = require('../storage');
        const prefs = storage.getPreferences();

        // Clear conversation history if target role or stack changes to force identity reset
        if (prefs.targetRole !== lastTargetRole || prefs.targetTechStack !== lastTargetTechStack) {
            console.log(
                `Target role/stack changed from "${lastTargetRole}"/"${lastTargetTechStack}" to "${prefs.targetRole}"/"${prefs.targetTechStack}". Clearing conversation history to reset identity.`
            );
            groqConversationHistory = [];
            lastTargetRole = prefs.targetRole;
            lastTargetTechStack = prefs.targetTechStack;
        }

        const profile = profileOverride || prefs.selectedProfile || currentProfile || 'interview';
        const rawCustomPrompt = customPromptOverride !== undefined ? customPromptOverride : prefs.customPrompt || '';
        
        const googleSearchEnabled = prefs.googleSearchEnabled !== false;
        currentProfile = profile;
        currentCustomPrompt = rawCustomPrompt;

        // Pass structured preferences to prompts.js instead of string-manipulating here
        currentSystemPrompt = getSystemPrompt({
            profile,
            customPrompt: rawCustomPrompt,
            targetRole: prefs.targetRole || '',
            targetTechStack: prefs.targetTechStack || '',
            jobDescription: prefs.jobDescription || '',
            googleSearchEnabled
        });
        return currentSystemPrompt;
    } catch (e) {
        console.error('Error refreshing system prompt:', e.message);
        return currentSystemPrompt || 'You are a helpful assistant.';
    }
}

// When true, Gemini's generationComplete -> Groq path is skipped because
// the renderer-side VAD + Groq Whisper pipeline handles transcription.
let whisperTranscriptionActive = false;

function formatSpeakerResults(results) {
    let text = '';
    for (const result of results) {
        if (result.transcript && result.speakerId) {
            const speakerLabel = result.speakerId === 1 ? 'Interviewer' : 'Candidate';
            text += `[${speakerLabel}]: ${result.transcript}\n`;
        }
    }
    return text;
}

module.exports.formatSpeakerResults = formatSpeakerResults;

// Audio capture variables
let systemAudioProc = null;
let messageBuffer = '';

// Reconnection variables
let isUserClosing = false;
let sessionParams = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_DELAY = 2000;

// API Key Rotation
let currentKeyIndex = 0;

// Debounce variables for voice activity detection gap tolerance
let sendResponseTimeout = null;
let pendingTranscription = '';
let latestGeminiResponse = '';

function rotateApiKey() {
    const rawKeys = getApiKey();
    if (!rawKeys) return null;
    const keys = rawKeys
        .split(/[,;\s]+/)
        .map(k => k.trim())
        .filter(Boolean);
    if (keys.length <= 1) return null;

    currentKeyIndex = (currentKeyIndex + 1) % keys.length;
    console.log(`Rotating API key to index ${currentKeyIndex}: ${keys[currentKeyIndex].slice(0, 8)}...`);
    return keys[currentKeyIndex];
}

function sendToRenderer(channel, data) {
    const windows = BrowserWindow.getAllWindows();
    if (windows.length > 0) {
        windows[0].webContents.send(channel, data);
    }
}

// Build context message for session restoration
function buildContextMessage() {
    const lastTurns = conversationHistory.slice(-20);
    const validTurns = lastTurns.filter(turn => turn.transcription?.trim() && turn.ai_response?.trim());

    if (validTurns.length === 0) return null;

    const contextLines = validTurns.map(turn => `[Interviewer]: ${turn.transcription.trim()}\n[Your answer]: ${turn.ai_response.trim()}`);

    return `Session reconnected. Here's the conversation so far:\n\n${contextLines.join('\n\n')}\n\nContinue from here.`;
}

// Conversation management functions
function initializeNewSession(profile = null, customPrompt = null) {
    currentSessionId = Date.now().toString();
    currentTranscription = '';
    conversationHistory = [];
    screenAnalysisHistory = [];
    groqConversationHistory = [];
    currentProfile = profile;
    currentCustomPrompt = customPrompt;
    console.log('New conversation session started:', currentSessionId, 'profile:', profile);

    // Save initial session with profile context
    if (profile) {
        sendToRenderer('save-session-context', {
            sessionId: currentSessionId,
            profile: profile,
            customPrompt: customPrompt || '',
        });
    }
}

function saveConversationTurn(transcription, aiResponse) {
    if (!currentSessionId) {
        initializeNewSession();
    }

    const conversationTurn = {
        timestamp: Date.now(),
        transcription: transcription.trim(),
        ai_response: aiResponse.trim(),
    };

    conversationHistory.push(conversationTurn);
    console.log('Saved conversation turn:', conversationTurn);

    // Send to renderer to save in IndexedDB
    sendToRenderer('save-conversation-turn', {
        sessionId: currentSessionId,
        turn: conversationTurn,
        fullHistory: conversationHistory,
    });
}

function saveScreenAnalysis(prompt, response, model) {
    if (!currentSessionId) {
        initializeNewSession();
    }

    const analysisEntry = {
        timestamp: Date.now(),
        prompt: prompt,
        response: response.trim(),
        model: model,
    };

    screenAnalysisHistory.push(analysisEntry);
    console.log('Saved screen analysis:', analysisEntry);

    // Send to renderer to save
    sendToRenderer('save-screen-analysis', {
        sessionId: currentSessionId,
        analysis: analysisEntry,
        fullHistory: screenAnalysisHistory,
        profile: currentProfile,
        customPrompt: currentCustomPrompt,
    });
}

function getCurrentSessionData() {
    return {
        sessionId: currentSessionId,
        history: conversationHistory,
    };
}

async function getEnabledTools() {
    const tools = [];

    // Check if Google Search is enabled (default: true)
    const googleSearchEnabled = await getStoredSetting('googleSearchEnabled', 'true');
    console.log('Google Search enabled:', googleSearchEnabled);

    if (googleSearchEnabled === 'true') {
        tools.push({ googleSearch: {} });
        console.log('Added Google Search tool');
    } else {
        console.log('Google Search tool disabled');
    }

    return tools;
}

async function getStoredSetting(key, defaultValue) {
    try {
        const windows = BrowserWindow.getAllWindows();
        if (windows.length > 0) {
            // Wait a bit for the renderer to be ready
            await new Promise(resolve => setTimeout(resolve, 100));

            // Try to get setting from renderer process localStorage
            const value = await windows[0].webContents.executeJavaScript(`
                (function() {
                    try {
                        if (typeof localStorage === 'undefined') {
                            console.log('localStorage not available yet for ${key}');
                            return '${defaultValue}';
                        }
                        const stored = localStorage.getItem('${key}');
                        console.log('Retrieved setting ${key}:', stored);
                        return stored || '${defaultValue}';
                    } catch (e) {
                        console.error('Error accessing localStorage for ${key}:', e);
                        return '${defaultValue}';
                    }
                })()
            `);
            return value;
        }
    } catch (error) {
        console.error('Error getting stored setting for', key, ':', error.message);
    }
    console.log('Using default value for', key, ':', defaultValue);
    return defaultValue;
}

// helper to check if groq has been configured
function hasGroqKey() {
    const keys = getGroqApiKeys();
    if (keys.length > 0) return true;
    const key = getGroqApiKey();
    return key && key.trim() !== '';
}

function trimConversationHistoryForGemma(history, maxChars = 42000) {
    if (!history || history.length === 0) return [];
    let totalChars = 0;
    const trimmed = [];

    for (let i = history.length - 1; i >= 0; i--) {
        const turn = history[i];
        const turnChars = (turn.content || '').length;

        if (totalChars + turnChars > maxChars) break;
        totalChars += turnChars;
        trimmed.unshift(turn);
    }
    return trimmed;
}

function stripThinkingTags(text) {
    if (!text) return '';
    // Strip completed <think>...</think> blocks, replacing with a space so words don't glue together
    let cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, ' ');
    // If still streaming inside an unclosed <think> tag, hide everything from <think> onwards
    cleaned = cleaned.replace(/<think>[\s\S]*$/gi, '');
    // Clean up extra spaces around punctuation
    cleaned = cleaned
        .replace(/\s+/g, ' ')
        .replace(/\s+([.,!?])/g, '$1')
        .trim();
    return cleaned;
}

function compressConversationHistory(history, maxTurns = 16) {
    if (!history || history.length <= maxTurns) return history;
    
    // Strict sliding window: drop older turns entirely
    let trimmed = history.slice(-maxTurns);
    
    // Ensure we don't start with an assistant message
    if (trimmed.length > 0 && trimmed[0].role === 'assistant') {
        trimmed = trimmed.slice(1);
    }
    
    return trimmed;
}

// Groq key rotation index (separate from Gemini key rotation)
let currentGroqKeyIndex = 0;

function getNextGroqKey() {
    const keys = getGroqApiKeys();
    if (keys.length === 0) return null;
    const key = keys[currentGroqKeyIndex % keys.length];
    return key;
}

function rotateGroqKey() {
    const keys = getGroqApiKeys();
    if (keys.length <= 1) return null;
    currentGroqKeyIndex = (currentGroqKeyIndex + 1) % keys.length;
    console.log(`Rotating Groq key to index ${currentGroqKeyIndex}`);
    return keys[currentGroqKeyIndex];
}

function detectQuestionComplexity(text) {
    if (!text || typeof text !== 'string') return 'simple';
    const cleaned = text.trim();
    const words = cleaned.split(/\s+/);
    if (words.length > 25) return 'complex';

    const complexKeywords =
        /function|class|algorithm|calculate|derive|solve|complexity|O\(n\)|code|debug|error|implement|optimize|sql|regex|pointer|recursion|tree|graph|dp|database|react|node|python|java|cpp|array|matrix|struct|hash|stack|queue|sort|search|binary|dynamic|proof|theorem|math|equation|integral|derivative/i;
    if (complexKeywords.test(cleaned)) return 'complex';

    const simplePatterns =
        /^(what is|who is|define|when was|which|yes or no|hello|hi|how are you|thanks|got it|tell me about|what does|meaning of)\b/i;
    if (simplePatterns.test(cleaned) || words.length < 12) return 'simple';

    return 'complex';
}

async function sendToGroq(transcription, fallbackResponse = '') {
    const keys = getGroqApiKeys();
    // Fall back to single key if multi-key list is empty
    const singleKey = getGroqApiKey();
    const allKeys = keys.length > 0 ? keys : singleKey ? [singleKey] : [];

    if (allKeys.length === 0) {
        console.log('No Groq API key configured, skipping Groq response');
        return;
    }

    const trimmed = transcription.trim().toLowerCase();
    const alphanumericOnly = trimmed.replace(/[^a-z0-9]/g, '');
    const fillerWords = [
        'okay', 'ok', 'ahm', 'mmm', 'mm', 'hmm', 'uh', 'um', 'yeah', 'yes', 'no', 'right', 'ah', 'oh', 'mhm',
        'you', 'me', 'so', 'and', 'but', 'the', 'a', 'an', 'is', 'it', 'to', 'in', 'of', 'on', 'at', 'as', 'well', 'like'
    ];

    if (!trimmed || alphanumericOnly.length < 2 || fillerWords.includes(alphanumericOnly)) {
        console.log(`Transcription filtered (noise/filler): "${transcription}", skipping Groq`);
        sendToRenderer('update-status', 'Listening...');
        return;
    }

    ensureSystemPrompt();
    const complexity = detectQuestionComplexity(transcription);
    const modelToUse = getModelForToday(complexity);
    if (!modelToUse) {
        console.log('All Groq daily limits exhausted');
        sendToRenderer('update-status', 'Groq limits reached for today');
        return;
    }

    console.log(`Sending to Groq (${modelToUse}):`, transcription.substring(0, 100) + '...');

    groqConversationHistory.push({
        role: 'user',
        content: transcription.trim(),
    });

    // Strict sliding window: keep exactly last 16 messages (8 exchanges)
    if (groqConversationHistory.length > 16) {
        groqConversationHistory = compressConversationHistory(groqConversationHistory, 16);
    }

    const lowerTrans = transcription.toLowerCase();
    const isCodeQuestion = lowerTrans.includes('implement') || 
                           lowerTrans.includes('write a function') ||
                           lowerTrans.includes('code') ||
                           lowerTrans.includes('algorithm') ||
                           lowerTrans.includes('derive') ||
                           lowerTrans.includes('math') ||
                           lowerTrans.includes('proof') ||
                           lowerTrans.includes('equation') ||
                           lowerTrans.includes('gradient') ||
                           lowerTrans.includes('calculate') ||
                           lowerTrans.includes('solve');
    // Bump limits specifically for format rules and reasoning tags
    // Non-code (3-4 sentences max): ~1536 tokens
    // Code (long logic + <think> blocks): ~3072 tokens
    const maxTokens = isCodeQuestion ? 3072 : 1536;

    // Build fallback candidate models list
    const modelsToTry = [...new Set([modelToUse, 'openai/gpt-oss-120b', 'llama-3.3-70b-versatile', 'llama-3.1-8b-instant'].filter(Boolean))];

    const requestMessages = [
        {
            role: 'system',
            content: currentSystemPrompt || 'You are a helpful assistant.',
        },
        ...groqConversationHistory.map(msg => ({ ...msg })) // Shallow copy to avoid mutating history
    ];
    
    let constraintCheckInjected = false;
    if (complexity === 'complex') {
        const lastMsg = requestMessages[requestMessages.length - 1];
        if (lastMsg && lastMsg.role === 'user') {
            lastMsg.content += `\n\n[CONSTRAINT CHECK]: Before answering, open a <think> block to identify any logical conflicts or impossible trade-offs in this scenario (e.g., demanding zero latency with synchronous cross-region replication). If a conflict exists, explicitly address the trade-off in your spoken answer instead of silently picking a side. If no genuine conflict exists, skip the trade-off discussion and answer normally — do not manufacture a conflict where the constraints are actually compatible. Begin your <think> block with either [CONFLICT DETECTED] or [NO CONFLICT] to explicitly state your conclusion.`;
            constraintCheckInjected = true;
            console.log(`[CONSTRAINT CHECK INJECTED] Question: "${transcription}"`);
        }
    }

    // Try each key and candidate model until one works
    let lastError = null;
    let success = false;

    for (const currentModel of modelsToTry) {
        if (success) break;
        for (let attempt = 0; attempt < allKeys.length; attempt++) {
            const groqApiKey = allKeys[currentGroqKeyIndex % allKeys.length];
            console.log(
                `Groq attempt ${attempt + 1}/${allKeys.length} using model ${currentModel} and key index ${currentGroqKeyIndex % allKeys.length}`
            );

            try {
                const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                    method: 'POST',
                    signal: AbortSignal.timeout(25000), // 25s timeout prevents hanging
                    headers: {
                        Authorization: `Bearer ${groqApiKey}`,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        model: currentModel,
                        messages: requestMessages,
                        stream: true,
                        temperature: 0.4,
                        max_tokens: maxTokens,
                    }),
                });

                if (!response.ok) {
                    const errorText = await response.text();
                    console.error(
                        `Groq API error with key index ${currentGroqKeyIndex % allKeys.length} (${currentModel}):`,
                        response.status,
                        errorText
                    );
                    lastError = new Error(`HTTP ${response.status}: ${errorText}`);
                    rotateGroqKey();
                    continue; // Try next key/model
                }

                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let fullText = '';
                let isFirst = true;
                let buffer = '';

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;

                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split('\n');
                    buffer = lines.pop(); // Hold incomplete line

                    for (const line of lines) {
                        const trimmedLine = line.trim();
                        if (trimmedLine.startsWith('data: ')) {
                            const data = trimmedLine.slice(6);
                            if (data === '[DONE]') continue;

                            try {
                                const json = JSON.parse(data);
                                const token = json.choices?.[0]?.delta?.content || '';
                                if (token) {
                                    fullText += token;
                                    const displayText = stripThinkingTags(fullText);
                                    if (displayText) {
                                        sendToRenderer(isFirst ? 'new-response' : 'update-response', displayText);
                                        isFirst = false;
                                    }
                                }
                            } catch {
                                // ignore incomplete JSON chunk
                            }
                        }
                    }
                }

                console.log(`[DEBUG] Final fullText length: ${fullText.length}`);
                if (fullText.length > 0 && fullText.length < 50) {
                    console.log(`[DEBUG] Final fullText: ${fullText}`);
                }

                const cleanedResponse = stripThinkingTags(fullText);
                console.log(`[DEBUG] Cleaned response length: ${cleanedResponse.length}`);

                if (constraintCheckInjected) {
                    if (fullText.includes('[CONFLICT DETECTED]')) {
                        console.log(`[CONSTRAINT CHECK LOG] Question: "${transcription}" -> Result: CONFLICT DETECTED`);
                    } else if (fullText.includes('[NO CONFLICT]')) {
                        console.log(`[CONSTRAINT CHECK LOG] Question: "${transcription}" -> Result: NO CONFLICT`);
                    } else {
                        console.log(`[CONSTRAINT CHECK LOG] Question: "${transcription}" -> Result: UNKNOWN (Model ignored prompt format)`);
                    }
                }

                // Fallback: if we never sent anything to the renderer (e.g. all <think> tags or empty chunks),
                // but we got some text, force send it now so the UI doesn't hang.
                if (isFirst && cleanedResponse.trim()) {
                    sendToRenderer('new-response', cleanedResponse);
                } else if (isFirst) {
                    sendToRenderer('new-response', '[Model returned empty response]');
                }

                const modelKey = currentModel.split('/').pop();

                const systemPromptChars = (currentSystemPrompt || 'You are a helpful assistant.').length;
                const historyChars = groqConversationHistory.reduce((sum, msg) => sum + (msg.content || '').length, 0);
                const inputChars = systemPromptChars + historyChars;
                const outputChars = cleanedResponse.length;

                incrementCharUsage('groq', modelKey, inputChars + outputChars);

                if (cleanedResponse) {
                    groqConversationHistory.push({
                        role: 'assistant',
                        content: cleanedResponse,
                    });

                    saveConversationTurn(transcription, cleanedResponse);
                }

                console.log(`Groq response completed (${currentModel}) using key index ${currentGroqKeyIndex % allKeys.length}`);
                sendToRenderer('update-status', 'Listening...');
                success = true;
                break; // Success - exit key retry loop
            } catch (error) {
                console.error(`Error calling Groq API with key index ${currentGroqKeyIndex % allKeys.length}:`, error);
                lastError = error;
                rotateGroqKey();
            }
        }
    }

    if (!success) {
        // All keys and models failed - clean up dangling user message so future attempts don't fail with role sequence errors
        if (groqConversationHistory.length > 0 && groqConversationHistory[groqConversationHistory.length - 1].role === 'user') {
            groqConversationHistory.pop();
        }
        console.error('All Groq API keys and fallback models failed. Last error:', lastError?.message);
        
        if (fallbackResponse && fallbackResponse.trim() !== '') {
            console.log('Falling back to Gemini Live API response');
            const cleanFallback = stripThinkingTags(fallbackResponse);
            sendToRenderer('new-response', cleanFallback);
            
            groqConversationHistory.push({
                role: 'assistant',
                content: cleanFallback,
            });
            saveConversationTurn(transcription, cleanFallback);
            sendToRenderer('update-status', 'Listening...');
        } else {
            sendToRenderer('update-status', 'Groq error: ' + (lastError?.message || 'All keys failed'));
            console.log('Falling back to Gemma...');
            sendToGemma(transcription);
        }
    }
}

async function sendToGemma(transcription) {
    const apiKey = getApiKey();
    if (!apiKey) {
        console.log('No Gemini API key configured');
        return;
    }

    if (!transcription || transcription.trim() === '') {
        console.log('Empty transcription, skipping Gemma');
        return;
    }

    ensureSystemPrompt();

    console.log('Sending to Gemma:', transcription.substring(0, 100) + '...');

    groqConversationHistory.push({
        role: 'user',
        content: transcription.trim(),
    });

    const trimmedHistory = trimConversationHistoryForGemma(groqConversationHistory, 42000);

    try {
        const ai = new GoogleGenAI({ apiKey: apiKey });

        const messages = trimmedHistory.map(msg => ({
            role: msg.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: msg.content }],
        }));

        const systemPrompt = currentSystemPrompt || 'You are a helpful assistant.';
        const response = await ai.models.generateContentStream({
            model: 'gemini-2.5-flash-lite',
            contents: messages,
            config: {
                systemInstruction: systemPrompt,
                // thinkingBudget 0 has negligible effect on flash-lite (it's a lite/fast model
                // with minimal thinking capacity — does not impact answer quality)
                thinkingConfig: { thinkingBudget: 0 },
            },
        });

        let fullText = '';
        let isFirst = true;

        for await (const chunk of response) {
            const chunkText = chunk.text;
            if (chunkText) {
                fullText += chunkText;
                sendToRenderer(isFirst ? 'new-response' : 'update-response', fullText);
                isFirst = false;
            }
        }

        const systemPromptChars = (currentSystemPrompt || 'You are a helpful assistant.').length;
        const historyChars = trimmedHistory.reduce((sum, msg) => sum + (msg.content || '').length, 0);
        const inputChars = systemPromptChars + historyChars;
        const outputChars = fullText.length;

        incrementCharUsage('gemini', 'gemini-2.5-flash-lite', inputChars + outputChars);

        if (fullText.trim()) {
            groqConversationHistory.push({
                role: 'assistant',
                content: fullText.trim(),
            });

            if (groqConversationHistory.length > 32) {
                groqConversationHistory = compressConversationHistory(groqConversationHistory, 32);
            }

            saveConversationTurn(transcription, fullText);
        }

        console.log('Gemma response completed');
        sendToRenderer('update-status', 'Listening...');
    } catch (error) {
        if (groqConversationHistory.length > 0 && groqConversationHistory[groqConversationHistory.length - 1].role === 'user') {
            groqConversationHistory.pop();
        }
        console.error('Error calling Gemma API:', error);
        sendToRenderer('update-status', 'Gemma error: ' + error.message);
    }
}

async function initializeGeminiSession(apiKey, customPrompt = '', profile = 'interview', language = 'en-US', isReconnect = false) {
    if (isInitializingSession) {
        console.log('Session initialization already in progress');
        return false;
    }

    isInitializingSession = true;
    if (!isReconnect) {
        sendToRenderer('session-initializing', true);
    }

    // Store params for reconnection
    if (!isReconnect) {
        sessionParams = { rawKeys: getApiKey(), apiKey, customPrompt, profile, language };
        reconnectAttempts = 0;
    }

    const client = new GoogleGenAI({
        vertexai: false,
        apiKey: apiKey,
        httpOptions: { apiVersion: 'v1alpha' },
    });

    // Get enabled tools first to determine Google Search status
    const enabledTools = await getEnabledTools();
    const googleSearchEnabled = enabledTools.some(tool => tool.googleSearch);

    const systemPrompt = getSystemPrompt(profile, customPrompt, googleSearchEnabled);
    currentSystemPrompt = systemPrompt; // Store for Groq

    // Initialize new conversation session only on first connect
    if (!isReconnect) {
        initializeNewSession(profile, customPrompt);
    }

    try {
        const session = await client.live.connect({
            model: 'gemini-3.1-flash-live-preview',
            callbacks: {
                onopen: function () {
                    sendToRenderer('update-status', 'Live session connected');
                },
                onmessage: function (message) {
                    // Handle input transcription (what was spoken)
                    let newSpeech = '';
                    if (message.serverContent?.inputTranscription?.results) {
                        newSpeech = formatSpeakerResults(message.serverContent.inputTranscription.results);
                    } else if (message.serverContent?.inputTranscription?.text) {
                        const text = message.serverContent.inputTranscription.text;
                        if (text.trim() !== '') {
                            newSpeech = text;
                        }
                    }

                    if (newSpeech) {
                        // If we had a pending response waiting to be sent, abort and merge it
                        if (sendResponseTimeout) {
                            clearTimeout(sendResponseTimeout);
                            sendResponseTimeout = null;
                            currentTranscription = pendingTranscription + ' ' + newSpeech;
                            pendingTranscription = '';
                            console.log('Interviewer continued speaking, merged transcription:', currentTranscription);
                        } else {
                            currentTranscription += newSpeech;
                        }
                    }

                    // ENABLED: Capture Gemini's outputTranscription to use as a fallback if Groq fails
                    if (message.serverContent?.outputTranscription?.text) {
                        latestGeminiResponse += message.serverContent.outputTranscription.text;
                    }

                    if (message.serverContent?.generationComplete) {
                        // When Whisper VAD handles transcription, skip the Gemini-based path
                        // to prevent duplicate responses.
                        if (whisperTranscriptionActive) {
                            messageBuffer = '';
                        } else if (currentTranscription.trim() !== '') {
                            if (sendResponseTimeout) {
                                clearTimeout(sendResponseTimeout);
                            }
                            pendingTranscription = currentTranscription.trim();
                            currentTranscription = '';

                            console.log('Speech pause detected, scheduling response in 2000ms...');
                            sendResponseTimeout = setTimeout(() => {
                                const textToSend = pendingTranscription;
                                pendingTranscription = '';
                                sendResponseTimeout = null;
                                
                                const fallback = latestGeminiResponse;
                                latestGeminiResponse = '';

                                console.log('Processing complete question:', textToSend);
                                if (hasGroqKey()) {
                                    sendToGroq(textToSend, fallback);
                                } else {
                                    sendToGemma(textToSend);
                                }
                            }, 2000); // 2 seconds debounce
                        } else {
                            messageBuffer = '';
                        }
                    }

                    if (message.serverContent?.turnComplete) {
                        sendToRenderer('update-status', 'Listening...');
                    }
                },
                onerror: function (e) {
                    console.log('Session error:', e.message);
                    sendToRenderer('update-status', 'Error: ' + e.message);
                },
                onclose: function (e) {
                    console.log('Session closed:', e.reason);

                    // Don't reconnect if user intentionally closed
                    if (isUserClosing) {
                        isUserClosing = false;
                        sendToRenderer('update-status', 'Session closed');
                        return;
                    }

                    // Don't auto-reconnect if it closed during initialization!
                    // The outer loop in initialize-byok will handle rotating keys for initialization failures.
                    if (isInitializingSession) {
                        return;
                    }

                    // Attempt reconnection
                    if (sessionParams && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
                        attemptReconnect();
                    } else {
                        sendToRenderer('update-status', 'Session closed');
                    }
                },
            },
            config: {
                responseModalities: [Modality.AUDIO],
                proactivity: { proactiveAudio: false },
                outputAudioTranscription: {},
                tools: [],
                // Enable speaker diarization
                inputAudioTranscription: {
                    enableSpeakerDiarization: true,
                    minSpeakerCount: 2,
                    maxSpeakerCount: 2,
                },
                contextWindowCompression: { slidingWindow: {} },
                speechConfig: { languageCode: language },
                systemInstruction: {
                    parts: [{ text: "You are a listening service. Only transcribe what you hear. Do not generate answers to questions.\n\n" + systemPrompt }],
                },
            },
        });

        isInitializingSession = false;
        if (!isReconnect) {
            sendToRenderer('session-initializing', false);
        }
        return session;
    } catch (error) {
        console.error('Failed to initialize Gemini session:', error);
        isInitializingSession = false;
        if (!isReconnect) {
            sendToRenderer('session-initializing', false);
        }
        return null;
    }
}

async function attemptReconnect() {
    reconnectAttempts++;
    console.log(`Reconnection attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}`);

    // Clear stale buffers
    messageBuffer = '';
    currentTranscription = '';
    // Don't reset groqConversationHistory to preserve context across reconnects

    sendToRenderer('update-status', `Reconnecting... (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);

    // Wait before attempting
    await new Promise(resolve => setTimeout(resolve, RECONNECT_DELAY));

    try {
        const rawKeys = sessionParams.rawKeys || sessionParams.apiKey;
        const keys = rawKeys
            .split(/[,;\s]+/)
            .map(k => k.trim())
            .filter(Boolean);

        // Rotate key for reconnection attempt if the previous connection failed
        if (reconnectAttempts > 1) {
            rotateApiKey();
        }

        const activeKey = keys[currentKeyIndex] || keys[0] || sessionParams.apiKey;
        console.log(`Reconnecting using key index ${currentKeyIndex}: ${activeKey.slice(0, 8)}...`);

        const session = await initializeGeminiSession(
            activeKey,
            sessionParams.customPrompt,
            sessionParams.profile,
            sessionParams.language,
            true // isReconnect
        );

        if (session && global.geminiSessionRef) {
            global.geminiSessionRef.current = session;

            // Restore context from conversation history via text message
            const contextMessage = buildContextMessage();
            if (contextMessage) {
                try {
                    console.log('Restoring conversation context...');
                    await session.sendRealtimeInput({ text: contextMessage });
                } catch (contextError) {
                    console.error('Failed to restore context:', contextError);
                    // Continue without context - better than failing
                }
            }

            // Don't reset reconnectAttempts here - let it reset on next fresh session
            sendToRenderer('update-status', 'Reconnected! Listening...');
            console.log('Session reconnected successfully');
            return true;
        } else {
            console.warn(`Reconnection attempt ${reconnectAttempts} failed to initialize session.`);
        }
    } catch (error) {
        console.error(`Reconnection attempt ${reconnectAttempts} failed:`, error);
    }

    // If we still have attempts left, try again
    if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        return attemptReconnect();
    }

    // Max attempts reached - notify frontend
    console.log('Max reconnection attempts reached');
    sendToRenderer('reconnect-failed', {
        message: 'Tried 3 times to reconnect. Must be upstream/network issues. Try restarting or download updated app from site.',
    });
    sessionParams = null;
    return false;
}

function killExistingSystemAudioDump() {
    return new Promise(resolve => {
        console.log('Checking for existing SystemAudioDump processes...');

        // Kill any existing SystemAudioDump processes
        const killProc = spawn('pkill', ['-f', 'SystemAudioDump'], {
            stdio: 'ignore',
        });

        killProc.on('close', code => {
            if (code === 0) {
                console.log('Killed existing SystemAudioDump processes');
            } else {
                console.log('No existing SystemAudioDump processes found');
            }
            resolve();
        });

        killProc.on('error', err => {
            console.log('Error checking for existing processes (this is normal):', err.message);
            resolve();
        });

        // Timeout after 2 seconds
        setTimeout(() => {
            killProc.kill();
            resolve();
        }, 2000);
    });
}

async function startMacOSAudioCapture(geminiSessionRef) {
    if (process.platform !== 'darwin') return false;

    // Kill any existing SystemAudioDump processes first
    await killExistingSystemAudioDump();

    console.log('Starting macOS audio capture with SystemAudioDump...');

    const { app } = require('electron');
    const path = require('path');

    let systemAudioPath;
    if (app.isPackaged) {
        systemAudioPath = path.join(process.resourcesPath, 'SystemAudioDump');
    } else {
        systemAudioPath = path.join(__dirname, '../assets', 'SystemAudioDump');
    }

    console.log('SystemAudioDump path:', systemAudioPath);

    const spawnOptions = {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
            ...process.env,
        },
    };

    systemAudioProc = spawn(systemAudioPath, [], spawnOptions);

    if (!systemAudioProc.pid) {
        console.error('Failed to start SystemAudioDump');
        return false;
    }

    console.log('SystemAudioDump started with PID:', systemAudioProc.pid);

    const CHUNK_DURATION = 0.1;
    const SAMPLE_RATE = 24000;
    const BYTES_PER_SAMPLE = 2;
    const CHANNELS = 2;
    const CHUNK_SIZE = SAMPLE_RATE * BYTES_PER_SAMPLE * CHANNELS * CHUNK_DURATION;

    let audioBuffer = Buffer.alloc(0);

    systemAudioProc.stdout.on('data', data => {
        audioBuffer = Buffer.concat([audioBuffer, data]);

        while (audioBuffer.length >= CHUNK_SIZE) {
            const chunk = audioBuffer.slice(0, CHUNK_SIZE);
            audioBuffer = audioBuffer.slice(CHUNK_SIZE);

            const monoChunk = CHANNELS === 2 ? convertStereoToMono(chunk) : chunk;

            if (currentProviderMode === 'cloud') {
                sendCloudAudio(monoChunk);
            } else if (currentProviderMode === 'local') {
                getLocalAi().processLocalAudio(monoChunk);
            } else {
                const base64Data = monoChunk.toString('base64');
                sendAudioToGemini(base64Data, geminiSessionRef);
            }

            if (process.env.DEBUG_AUDIO) {
                console.log(`Processed audio chunk: ${chunk.length} bytes`);
                saveDebugAudio(monoChunk, 'system_audio');
            }
        }

        const maxBufferSize = SAMPLE_RATE * BYTES_PER_SAMPLE * 1;
        if (audioBuffer.length > maxBufferSize) {
            audioBuffer = audioBuffer.slice(-maxBufferSize);
        }
    });

    systemAudioProc.stderr.on('data', data => {
        console.error('SystemAudioDump stderr:', data.toString());
    });

    systemAudioProc.on('close', code => {
        console.log('SystemAudioDump process closed with code:', code);
        systemAudioProc = null;
    });

    systemAudioProc.on('error', err => {
        console.error('SystemAudioDump process error:', err);
        systemAudioProc = null;
    });

    return true;
}

function convertStereoToMono(stereoBuffer) {
    const samples = stereoBuffer.length / 4;
    const monoBuffer = Buffer.alloc(samples * 2);

    for (let i = 0; i < samples; i++) {
        const leftSample = stereoBuffer.readInt16LE(i * 4);
        monoBuffer.writeInt16LE(leftSample, i * 2);
    }

    return monoBuffer;
}

function stopMacOSAudioCapture() {
    if (systemAudioProc) {
        console.log('Stopping SystemAudioDump...');
        systemAudioProc.kill('SIGTERM');
        systemAudioProc = null;
    }
}

async function sendAudioToGemini(base64Data, geminiSessionRef) {
    if (!geminiSessionRef.current) return;

    try {
        process.stdout.write('.');
        await geminiSessionRef.current.sendRealtimeInput({
            audio: {
                data: base64Data,
                mimeType: 'audio/pcm;rate=24000',
            },
        });
    } catch (error) {
        console.error('Error sending audio to Gemini:', error);
    }
}

// Groq vision models in order of speed preference
// llama-4-scout: fastest TTFT (~300ms), good quality
// llama-4-maverick: slightly slower, better on complex screens
const GROQ_VISION_MODELS = ['meta-llama/llama-4-scout-17b-16e-instruct', 'meta-llama/llama-4-maverick-17b-128e-instruct'];

async function sendImageToGroq(base64Data, prompt) {
    const keys = getGroqApiKeys();
    const singleKey = getGroqApiKey();
    const allKeys = keys.length > 0 ? keys : singleKey ? [singleKey] : [];

    if (allKeys.length === 0) {
        return { success: false, error: 'No Groq API key configured' };
    }

    // Refresh system prompt so screen capture answers respect current target role
    ensureSystemPrompt();

    // Try each vision model in speed order
    for (const model of GROQ_VISION_MODELS) {
        let lastError = null;

        // Try each key for this model
        for (let attempt = 0; attempt < allKeys.length; attempt++) {
            const groqApiKey = allKeys[currentGroqKeyIndex % allKeys.length];
            console.log(`Sending image to Groq (${model}) key index ${currentGroqKeyIndex % allKeys.length}...`);

            try {
                const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${groqApiKey}`,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        model,
                        messages: [
                            ...(currentSystemPrompt ? [{ role: 'system', content: currentSystemPrompt }] : []),
                            {
                                role: 'user',
                                content: [
                                    {
                                        type: 'image_url',
                                        image_url: {
                                            url: `data:image/jpeg;base64,${base64Data}`,
                                            detail: 'high',
                                        },
                                    },
                                    { type: 'text', text: prompt },
                                ],
                            },
                        ],
                        stream: true,
                        max_tokens: 512,
                        temperature: 0.4,
                    }),
                });

                if (!response.ok) {
                    const errorText = await response.text();
                    console.error(`Groq vision error (${model}) key ${currentGroqKeyIndex % allKeys.length}:`, response.status, errorText);
                    lastError = new Error(`HTTP ${response.status}: ${errorText}`);
                    if (response.status === 429 || response.status === 401 || response.status === 403) {
                        rotateGroqKey();
                        continue;
                    }
                    break; // non-retryable error for this model
                }

                // Stream response — first token arrives in ~300ms on Groq
                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let fullText = '';
                let isFirst = true;
                let buffer = '';

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;

                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split('\n');
                    buffer = lines.pop(); // Hold incomplete line

                    for (const line of lines) {
                        const trimmedLine = line.trim();
                        if (trimmedLine.startsWith('data: ')) {
                            const data = trimmedLine.slice(6);
                            if (data === '[DONE]') continue;
                            try {
                                const json = JSON.parse(data);
                                const token = json.choices?.[0]?.delta?.content || '';
                                if (token) {
                                    fullText += token;
                                    const displayText = stripThinkingTags(fullText);
                                    if (displayText) {
                                        sendToRenderer(isFirst ? 'new-response' : 'update-response', displayText);
                                        isFirst = false;
                                    }
                                }
                            } catch (_) {
                                // skip malformed chunks
                            }
                        }
                    }
                }

                console.log(`Groq vision completed (${model}), ~${fullText.length} chars`);
                saveScreenAnalysis(prompt, fullText, model);
                return { success: true, text: fullText, model };
            } catch (err) {
                console.error(`Groq vision fetch error (${model}):`, err.message);
                lastError = err;
                rotateGroqKey();
            }
        }
        // If all keys failed on this model, try next model
        console.warn(`All Groq keys exhausted for ${model}, trying next vision model...`);
    }

    return { success: false, error: 'All Groq vision models/keys failed' };
}

async function sendImageToGeminiHttp(base64Data, prompt, profile = null) {
    const rawKeys = getApiKey();
    if (!rawKeys) {
        return { success: false, error: 'No API key configured' };
    }
    const keys = rawKeys
        .split(/[,;\s]+/)
        .map(k => k.trim())
        .filter(Boolean);
    if (keys.length === 0) {
        return { success: false, error: 'No valid API key configured' };
    }

    let lastError = null;
    for (let attempt = 0; attempt < keys.length; attempt++) {
        const activeKey = keys[currentKeyIndex] || keys[0];
        try {
            // Get available model based on rate limits
            const model = getAvailableModel();
            const ai = new GoogleGenAI({ apiKey: activeKey });

            // Handle both single image string and array of image strings
            const imageParts = Array.isArray(base64Data)
                ? base64Data.map(data => ({ inlineData: { mimeType: 'image/jpeg', data } }))
                : [{ inlineData: { mimeType: 'image/jpeg', data: base64Data } }];

            const contents = [
                ...imageParts,
                { text: prompt },
            ];

            const generateConfig = currentSystemPrompt ? { systemInstruction: currentSystemPrompt } : {};

            console.log(`Sending image to ${model} using key index ${currentKeyIndex} (streaming)...`);
            const response = await ai.models.generateContentStream({
                model: model,
                contents: contents,
                config: generateConfig,
            });

            // Increment count after successful call
            incrementLimitCount(model);

            // Stream the response
            let fullText = '';
            let isFirst = true;
            for await (const chunk of response) {
                const chunkText = chunk.text;
                if (chunkText) {
                    fullText += chunkText;
                    // Send to renderer - new response for first chunk, update for subsequent
                    sendToRenderer(isFirst ? 'new-response' : 'update-response', fullText);
                    isFirst = false;
                }
            }

            console.log(`Image response completed from ${model}`);

            // Save screen analysis to history
            saveScreenAnalysis(prompt, fullText, model);

            return { success: true, text: fullText, model: model };
        } catch (error) {
            console.error(`Error sending image to Gemini HTTP using key index ${currentKeyIndex}:`, error);
            lastError = error;
            // Rotate key for next attempt
            rotateApiKey();
        }
    }
    return { success: false, error: `All keys failed. Last error: ${lastError ? lastError.message : 'Unknown'}` };
}

// Convert raw PCM buffer to WAV buffer in memory (no file I/O).
function pcmToWavBuffer(pcmBuffer, sampleRate = 24000, channels = 1, bitDepth = 16) {
    const byteRate = sampleRate * channels * (bitDepth / 8);
    const blockAlign = channels * (bitDepth / 8);
    const dataSize = pcmBuffer.length;

    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(dataSize + 36, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitDepth, 34);
    header.write('data', 36);
    header.writeUInt32LE(dataSize, 40);

    return Buffer.concat([header, pcmBuffer]);
}

function setupGeminiIpcHandlers(geminiSessionRef) {
    // Store the geminiSessionRef globally for reconnection access
    global.geminiSessionRef = geminiSessionRef;

    ipcMain.handle('initialize-cloud', async (event, token, profile, userContext) => {
        try {
            currentProviderMode = 'cloud';
            initializeNewSession(profile);
            setOnTurnComplete((transcription, response) => {
                saveConversationTurn(transcription, response);
            });
            sendToRenderer('session-initializing', true);
            await connectCloud(token, profile, userContext);
            sendToRenderer('session-initializing', false);
            return true;
        } catch (err) {
            console.error('[Cloud] Init error:', err);
            currentProviderMode = 'byok';
            sendToRenderer('session-initializing', false);
            return false;
        }
    });

    ipcMain.handle('initialize-gemini', async (event, apiKey, customPrompt, profile = 'interview', language = 'en-US') => {
        currentProviderMode = 'byok';

        const rawKeys = apiKey;
        if (!rawKeys) return false;
        const keys = rawKeys
            .split(/[,;\s]+/)
            .map(k => k.trim())
            .filter(Boolean);
        if (keys.length === 0) return false;

        // Reset currentKeyIndex for a new session initiation
        currentKeyIndex = 0;

        for (let attempt = 0; attempt < keys.length; attempt++) {
            const activeKey = keys[currentKeyIndex];
            console.log(`Connecting Gemini Live session using key index ${currentKeyIndex}...`);
            const session = await initializeGeminiSession(activeKey, customPrompt, profile, language);
            if (session) {
                geminiSessionRef.current = session;

                // Activate Whisper-based transcription when Groq keys are available.
                // This provides faster, more reliable transcription than Gemini Live's
                // built-in inputTranscription.
                if (hasGroqKey()) {
                    whisperTranscriptionActive = true;
                    console.log('Whisper VAD transcription ACTIVE — Gemini transcription path disabled');
                } else {
                    whisperTranscriptionActive = false;
                    console.log('No Groq key — using Gemini transcription path');
                }

                return true;
            }
            console.warn(`Key index ${currentKeyIndex} failed, rotating...`);
            rotateApiKey();
        }
        return false;
    });

    ipcMain.handle('initialize-local', async (event, ollamaHost, ollamaModel, whisperModel, profile, customPrompt) => {
        currentProviderMode = 'local';
        const success = await getLocalAi().initializeLocalSession(ollamaHost, ollamaModel, whisperModel, profile, customPrompt);
        if (!success) {
            currentProviderMode = 'byok';
        }
        return success;
    });

    ipcMain.handle('send-audio-content', async (event, { data, mimeType }) => {
        if (currentProviderMode === 'cloud') {
            try {
                const pcmBuffer = Buffer.from(data, 'base64');
                sendCloudAudio(pcmBuffer);
                return { success: true };
            } catch (error) {
                console.error('Error sending cloud audio:', error);
                return { success: false, error: error.message };
            }
        }
        if (currentProviderMode === 'local') {
            try {
                const pcmBuffer = Buffer.from(data, 'base64');
                getLocalAi().processLocalAudio(pcmBuffer);
                return { success: true };
            } catch (error) {
                console.error('Error sending local audio:', error);
                return { success: false, error: error.message };
            }
        }
        if (!geminiSessionRef.current) return { success: false, error: 'No active Gemini session' };
        try {
            process.stdout.write('.');
            await geminiSessionRef.current.sendRealtimeInput({
                audio: { data: data, mimeType: mimeType },
            });
            return { success: true };
        } catch (error) {
            console.error('Error sending system audio:', error);
            return { success: false, error: error.message };
        }
    });

    // Handle microphone audio on a separate channel
    ipcMain.handle('send-mic-audio-content', async (event, { data, mimeType }) => {
        if (currentProviderMode === 'cloud') {
            try {
                const pcmBuffer = Buffer.from(data, 'base64');
                sendCloudAudio(pcmBuffer);
                return { success: true };
            } catch (error) {
                console.error('Error sending cloud mic audio:', error);
                return { success: false, error: error.message };
            }
        }
        if (currentProviderMode === 'local') {
            try {
                const pcmBuffer = Buffer.from(data, 'base64');
                getLocalAi().processLocalAudio(pcmBuffer);
                return { success: true };
            } catch (error) {
                console.error('Error sending local mic audio:', error);
                return { success: false, error: error.message };
            }
        }
        if (!geminiSessionRef.current) return { success: false, error: 'No active Gemini session' };
        try {
            process.stdout.write(',');
            await geminiSessionRef.current.sendRealtimeInput({
                audio: { data: data, mimeType: mimeType },
            });
            return { success: true };
        } catch (error) {
            console.error('Error sending mic audio:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('send-image-content', async (event, { data, prompt, profile }) => {
        try {
            if (!data || typeof data !== 'string') {
                console.error('Invalid image data received');
                return { success: false, error: 'Invalid image data' };
            }

            const buffer = Buffer.from(data, 'base64');

            if (buffer.length < 1000) {
                console.error(`Image buffer too small: ${buffer.length} bytes`);
                return { success: false, error: 'Image buffer too small' };
            }

            process.stdout.write('!');

            if (currentProviderMode === 'cloud') {
                const sent = sendCloudImage(data);
                if (!sent) {
                    return { success: false, error: 'Cloud connection not active' };
                }
                return { success: true, model: 'cloud' };
            }

            if (currentProviderMode === 'local') {
                const result = await getLocalAi().sendLocalImage(data, prompt);
                return result;
            }

            // Try Groq vision first — much faster (~1s vs 9s), uses rotating free keys
            // Falls back to Gemini HTTP only if all Groq keys/models fail
            const groqKeys = getGroqApiKeys();
            const hasSingleGroqKey = getGroqApiKey();
            const hasGroqVision = groqKeys.length > 0 || (hasSingleGroqKey && hasSingleGroqKey.trim());
            if (hasGroqVision) {
                console.log('Using Groq vision (fast path)...');
                const groqResult = await sendImageToGroq(data, prompt);
                if (groqResult.success) return groqResult;
                console.warn('Groq vision failed, falling back to Gemini HTTP:', groqResult.error);
            }

            // Fallback: Gemini HTTP (or primary path if no Groq keys)
            const result = await sendImageToGeminiHttp(data, prompt, profile);
            return result;
        } catch (error) {
            console.error('Error sending image:', error);
            return { success: false, error: error.message };
        }
    });

    // -------------------------------------------------------------------------
    // Native OS-level screenshot capture
    // Uses Electron's desktopCapturer from the main process instead of
    // renderer-side getDisplayMedia, making it invisible to browser telemetry.
    // -------------------------------------------------------------------------
    ipcMain.handle('capture-native-screenshot', async (event, { quality = 70, maxWidth = 1280 } = {}) => {
        try {
            const { desktopCapturer } = require('electron');
            const sources = await desktopCapturer.getSources({
                types: ['screen'],
                thumbnailSize: { width: 1920, height: 1080 },
            });

            if (sources.length === 0) {
                return { success: false, error: 'No screen sources found' };
            }

            const primaryScreen = sources[0];
            let thumbnail = primaryScreen.thumbnail;

            // Downscale if wider than maxWidth
            const srcSize = thumbnail.getSize();
            if (srcSize.width > maxWidth) {
                const destHeight = Math.round(srcSize.height * (maxWidth / srcSize.width));
                thumbnail = thumbnail.resize({ width: maxWidth, height: destHeight });
            }

            const jpegBuffer = thumbnail.toJPEG(quality);
            const base64 = jpegBuffer.toString('base64');

            return { success: true, data: base64, width: thumbnail.getSize().width, height: thumbnail.getSize().height };
        } catch (error) {
            console.error('Native screenshot error:', error);
            return { success: false, error: error.message };
        }
    });

    // -------------------------------------------------------------------------
    // Accumulated multi-image answer handler
    // Receives multiple screenshot frames captured over time and sends them
    // as a single multi-image prompt to the vision model for a complete answer.
    // -------------------------------------------------------------------------
    ipcMain.handle('send-accumulated-images', async (event, { images, prompt, profile }) => {
        try {
            if (!images || images.length === 0) {
                return { success: false, error: 'No images provided' };
            }

            console.log(`Processing ${images.length} accumulated screenshot(s)...`);

            // For single image, use existing path
            if (images.length === 1) {
                return await ipcMain.emit('send-image-content', event, { data: images[0], prompt }) ||
                    await (async () => {
                        // Direct call to the image handler logic
                        const data = images[0];
                        const buffer = Buffer.from(data, 'base64');
                        if (buffer.length < 1000) {
                            return { success: false, error: 'Image buffer too small' };
                        }

                        if (currentProviderMode === 'cloud') {
                            sendCloudImage(data);
                            return { success: true, model: 'cloud' };
                        }
                        if (currentProviderMode === 'local') {
                            return await getLocalAi().sendLocalImage(data, prompt);
                        }

                        const groqKeys = getGroqApiKeys();
                        const hasSingleGroqKey = getGroqApiKey();
                        const hasGroqVision = groqKeys.length > 0 || (hasSingleGroqKey && hasSingleGroqKey.trim());
                        if (hasGroqVision) {
                            const groqResult = await sendImageToGroq(data, prompt);
                            if (groqResult.success) return groqResult;
                        }
                        return await sendImageToGeminiHttp(data, prompt);
                    })();
            }

            // Multi-image: construct combined prompt with all frames
            const multiImagePrompt = `The following ${images.length} images show different parts of the same screen, captured as the user scrolled through a coding problem or question. Combine ALL visible information from every image to understand the COMPLETE problem before answering.\n\n${prompt}`;

            ensureSystemPrompt();

            // Try Groq vision first (multi-image support)
            const groqKeys = getGroqApiKeys();
            const hasSingleGroqKey = getGroqApiKey();
            const hasGroqVision = groqKeys.length > 0 || (hasSingleGroqKey && hasSingleGroqKey.trim());

            if (hasGroqVision) {
                const allKeys = groqKeys.length > 0 ? groqKeys : [hasSingleGroqKey];

                for (const model of GROQ_VISION_MODELS) {
                    for (let attempt = 0; attempt < allKeys.length; attempt++) {
                        const groqApiKey = allKeys[currentGroqKeyIndex % allKeys.length];
                        try {
                            const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                                method: 'POST',
                                headers: {
                                    Authorization: `Bearer ${groqApiKey}`,
                                    'Content-Type': 'application/json',
                                },
                                body: JSON.stringify({
                                    model,
                                    messages: [
                                        ...(currentSystemPrompt ? [{ role: 'system', content: currentSystemPrompt }] : []),
                                        {
                                            role: 'user',
                                            content: [
                                                ...images.map(img => ({
                                                    type: 'image_url',
                                                    image_url: {
                                                        url: `data:image/jpeg;base64,${img}`,
                                                        detail: 'high',
                                                    },
                                                })),
                                                { type: 'text', text: multiImagePrompt },
                                            ],
                                        },
                                    ],
                                    stream: true,
                                    max_tokens: 2048,
                                    temperature: 0.4,
                                }),
                            });

                            if (!response.ok) {
                                if (response.status === 429 || response.status === 401 || response.status === 403) {
                                    rotateGroqKey();
                                    continue;
                                }
                                break;
                            }

                            const reader = response.body.getReader();
                            const decoder = new TextDecoder();
                            let fullText = '';
                            let isFirst = true;
                            let buffer = '';

                            while (true) {
                                const { done, value } = await reader.read();
                                if (done) break;

                                buffer += decoder.decode(value, { stream: true });
                                const lines = buffer.split('\n');
                                buffer = lines.pop(); // Hold incomplete line

                                for (const line of lines) {
                                    const trimmedLine = line.trim();
                                    if (trimmedLine.startsWith('data: ')) {
                                        const data = trimmedLine.slice(6);
                                        if (data === '[DONE]') continue;
                                        try {
                                            const json = JSON.parse(data);
                                            const token = json.choices?.[0]?.delta?.content || '';
                                            if (token) {
                                                fullText += token;
                                                const displayText = stripThinkingTags(fullText);
                                                if (displayText) {
                                                    sendToRenderer(isFirst ? 'new-response' : 'update-response', displayText);
                                                    isFirst = false;
                                                }
                                            }
                                        } catch (_) {}
                                    }
                                }
                            }

                            console.log(`Multi-image response completed (${model}), ${images.length} frames, ~${fullText.length} chars`);
                            saveScreenAnalysis(multiImagePrompt, fullText, model);
                            return { success: true, text: fullText, model };
                        } catch (err) {
                            console.error(`Groq multi-image fetch error (${model}):`, err.message);
                            rotateGroqKey();
                        }
                    }
                }
            }

            console.warn('Groq multi-image failed, falling back to Gemini HTTP');
            return await sendImageToGeminiHttp(images, multiImagePrompt, profile);
        } catch (error) {
            console.error('Error processing accumulated images:', error);
            return { success: false, error: error.message };
        }
    });

    // -------------------------------------------------------------------------
    // Whisper VAD transcription handler
    // Receives raw PCM audio from the renderer's voice activity detector,
    // transcribes it via Groq Whisper, then sends the text to Groq/Gemma.
    // -------------------------------------------------------------------------
    ipcMain.handle('whisper-transcribe-respond', async (event, base64Audio) => {
        const keys = getGroqApiKeys();
        const singleKey = getGroqApiKey();
        const allKeys = keys.length > 0 ? keys : singleKey ? [singleKey] : [];

        if (allKeys.length === 0) {
            return { success: false, error: 'No Groq API key configured for Whisper' };
        }

        try {
            const pcmBuffer = Buffer.from(base64Audio, 'base64');

            // Skip tiny buffers that are likely noise
            if (pcmBuffer.length < 4800) {
                // Less than 0.1s at 24kHz/16bit
                return { success: false, error: 'Audio too short' };
            }

            // Convert PCM to WAV in memory
            const wavBuffer = pcmToWavBuffer(pcmBuffer, 24000, 1, 16);

            sendToRenderer('update-status', 'Transcribing...');

            // Try each Groq key
            let lastError = null;
            for (let attempt = 0; attempt < allKeys.length; attempt++) {
                const groqKey = allKeys[currentGroqKeyIndex % allKeys.length];

                try {
                    // Build multipart form data manually for Node.js fetch
                    const boundary = '----WhisperBoundary' + Date.now();
                    const parts = [];

                    // File part
                    parts.push(
                        `--${boundary}\r\n` +
                            `Content-Disposition: form-data; name="file"; filename="audio.wav"\r\n` +
                            `Content-Type: audio/wav\r\n\r\n`
                    );
                    parts.push(wavBuffer);
                    parts.push('\r\n');

                    // Model part
                    parts.push(`--${boundary}\r\n` + `Content-Disposition: form-data; name="model"\r\n\r\n` + `whisper-large-v3-turbo\r\n`);

                    // Response format part
                    parts.push(`--${boundary}\r\n` + `Content-Disposition: form-data; name="response_format"\r\n\r\n` + `text\r\n`);

                    // Language part
                    parts.push(`--${boundary}\r\n` + `Content-Disposition: form-data; name="language"\r\n\r\n` + `en\r\n`);

                    // End boundary
                    parts.push(`--${boundary}--\r\n`);

                    // Combine into single buffer
                    const bodyParts = parts.map(p => (typeof p === 'string' ? Buffer.from(p) : p));
                    const body = Buffer.concat(bodyParts);

                    const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
                        method: 'POST',
                        signal: AbortSignal.timeout(15000),
                        headers: {
                            Authorization: `Bearer ${groqKey}`,
                            'Content-Type': `multipart/form-data; boundary=${boundary}`,
                        },
                        body: body,
                    });

                    if (!response.ok) {
                        const errorText = await response.text();
                        console.error(`Whisper API error (key ${currentGroqKeyIndex % allKeys.length}):`, response.status, errorText);
                        lastError = new Error(`HTTP ${response.status}: ${errorText}`);
                        if (response.status === 429 || response.status === 401 || response.status === 403) {
                            rotateGroqKey();
                            continue;
                        }
                        break;
                    }

                    const transcription = (await response.text()).trim();
                    console.log('Whisper transcription:', transcription);

                    if (!transcription || transcription.length < 2) {
                        sendToRenderer('update-status', 'Listening...');
                        return { success: true, text: '' };
                    }

                    sendToRenderer('update-status', 'Processing answer...');

                    // Send to Groq/Gemma for AI response
                    if (hasGroqKey()) {
                        await sendToGroq(transcription);
                    } else {
                        await sendToGemma(transcription);
                    }

                    return { success: true, text: transcription };
                } catch (fetchErr) {
                    console.error(`Whisper fetch error (key ${currentGroqKeyIndex % allKeys.length}):`, fetchErr.message);
                    lastError = fetchErr;
                    rotateGroqKey();
                }
            }

            sendToRenderer('update-status', 'Whisper error: ' + (lastError?.message || 'All keys failed'));
            return { success: false, error: lastError?.message || 'All Groq keys failed for Whisper' };
        } catch (error) {
            console.error('Whisper transcription handler error:', error);
            sendToRenderer('update-status', 'Listening...');
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('send-text-message', async (event, text) => {
        if (!text || typeof text !== 'string' || text.trim().length === 0) {
            return { success: false, error: 'Invalid text message' };
        }

        if (currentProviderMode === 'cloud') {
            try {
                console.log('Sending text to cloud:', text);
                sendCloudText(text.trim());
                return { success: true };
            } catch (error) {
                console.error('Error sending cloud text:', error);
                return { success: false, error: error.message };
            }
        }

        if (currentProviderMode === 'local') {
            try {
                console.log('Sending text to local Ollama:', text);
                return await getLocalAi().sendLocalText(text.trim());
            } catch (error) {
                console.error('Error sending local text:', error);
                return { success: false, error: error.message };
            }
        }

        if (!geminiSessionRef.current) return { success: false, error: 'No active Gemini session' };

        try {
            console.log('Sending text message:', text);

            if (hasGroqKey()) {
                sendToGroq(text.trim());
            } else {
                sendToGemma(text.trim());
            }

            await geminiSessionRef.current.sendRealtimeInput({ text: text.trim() });
            return { success: true };
        } catch (error) {
            console.error('Error sending text:', error);
            return { success: false, error: error.message };
        }
    });

    // -------------------------------------------------------------------------
    // RAG-enabled text handler
    // Retrieves relevant knowledge-base docs and prepends them to the prompt
    // before forwarding to the active provider (Gemini / Groq / Ollama / Cloud).
    // -------------------------------------------------------------------------
    ipcMain.handle('send-rag-question', async (event, text) => {
        if (!text || typeof text !== 'string' || text.trim().length === 0) {
            return { success: false, error: 'Invalid text message' };
        }

        let augmentedText = text.trim();

        try {
            const storage = require('../storage');
            const prefs = storage.getPreferences();

            if (prefs.ragEnabled) {
                const rag = require('./rag');
                const relevantDocs = await rag.getRelevantDocs(text.trim());

                if (relevantDocs.length > 0) {
                    const path = require('path');
                    const docsBlock = relevantDocs.map(doc => `Source: ${path.basename(doc.path)}\n${doc.text.slice(0, 800)}`).join('\n---\n');

                    augmentedText =
                        `The following is background information about the candidate (their skills, projects, experience, and prepared interview answers). ` +
                        `Use this background to craft a confident, first-person answer to the interview question below. ` +
                        `Speak directly as the candidate — do NOT reference "the knowledge base", "the excerpt", or "the document". ` +
                        `Sound natural, specific, and human.\n\n` +
                        `=== CANDIDATE BACKGROUND ===\n${docsBlock}\n=== END BACKGROUND ===\n\n` +
                        `Interview question: ${text.trim()}`;

                    console.log(`RAG: injected ${relevantDocs.length} doc(s) into prompt`);
                } else {
                    console.log('RAG: no matching docs – sending raw prompt');
                }
            } else {
                console.log('RAG: disabled by user preferences – sending raw prompt');
            }
        } catch (ragErr) {
            console.warn('RAG retrieval failed, falling back to raw prompt:', ragErr.message);
        }

        // Delegate to the active provider using the (possibly augmented) prompt
        if (currentProviderMode === 'cloud') {
            try {
                sendCloudText(augmentedText);
                return { success: true };
            } catch (error) {
                console.error('Error sending cloud RAG text:', error);
                return { success: false, error: error.message };
            }
        }

        if (currentProviderMode === 'local') {
            try {
                return await getLocalAi().sendLocalText(augmentedText);
            } catch (error) {
                console.error('Error sending local RAG text:', error);
                return { success: false, error: error.message };
            }
        }

        if (!geminiSessionRef.current) return { success: false, error: 'No active Gemini session' };

        try {
            if (hasGroqKey()) {
                sendToGroq(augmentedText);
            } else {
                sendToGemma(augmentedText);
            }
            await geminiSessionRef.current.sendRealtimeInput({ text: augmentedText });
            return { success: true };
        } catch (error) {
            console.error('Error sending RAG text:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('start-macos-audio', async event => {
        if (process.platform !== 'darwin') {
            return {
                success: false,
                error: 'macOS audio capture only available on macOS',
            };
        }

        try {
            const success = await startMacOSAudioCapture(geminiSessionRef);
            return { success };
        } catch (error) {
            console.error('Error starting macOS audio capture:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('stop-macos-audio', async event => {
        try {
            stopMacOSAudioCapture();
            return { success: true };
        } catch (error) {
            console.error('Error stopping macOS audio capture:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('close-session', async event => {
        try {
            stopMacOSAudioCapture();

            if (currentProviderMode === 'cloud') {
                closeCloud();
                currentProviderMode = 'byok';
                return { success: true };
            }

            if (currentProviderMode === 'local') {
                getLocalAi().closeLocalSession();
                currentProviderMode = 'byok';
                return { success: true };
            }

            // Set flag to prevent reconnection attempts
            isUserClosing = true;
            sessionParams = null;

            // Cleanup session
            if (geminiSessionRef.current) {
                await geminiSessionRef.current.close();
                geminiSessionRef.current = null;
            }

            return { success: true };
        } catch (error) {
            console.error('Error closing session:', error);
            return { success: false, error: error.message };
        }
    });

    // Conversation history IPC handlers
    ipcMain.handle('get-current-session', async event => {
        try {
            return { success: true, data: getCurrentSessionData() };
        } catch (error) {
            console.error('Error getting current session:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('start-new-session', async event => {
        try {
            initializeNewSession();
            return { success: true, sessionId: currentSessionId };
        } catch (error) {
            console.error('Error starting new session:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('update-google-search-setting', async (event, enabled) => {
        try {
            console.log('Google Search setting updated to:', enabled);
            // The setting is already saved in localStorage by the renderer
            // This is just for logging/confirmation
            return { success: true };
        } catch (error) {
            console.error('Error updating Google Search setting:', error);
            return { success: false, error: error.message };
        }
    });
}

module.exports = {
    initializeGeminiSession,
    getEnabledTools,
    getStoredSetting,
    sendToRenderer,
    initializeNewSession,
    saveConversationTurn,
    getCurrentSessionData,
    killExistingSystemAudioDump,
    startMacOSAudioCapture,
    convertStereoToMono,
    stopMacOSAudioCapture,
    sendAudioToGemini,
    sendImageToGeminiHttp,
    setupGeminiIpcHandlers,
    formatSpeakerResults,
    ensureSystemPrompt,
    refreshSystemPrompt,
};
