// renderer.js
const { ipcRenderer } = require('electron');

let mediaStream = null;
let screenshotInterval = null;
let audioContext = null;
let audioProcessor = null;
let micAudioProcessor = null;
let audioBuffer = [];
const SAMPLE_RATE = 24000;
const AUDIO_CHUNK_DURATION = 0.1; // seconds
const BUFFER_SIZE = 4096; // Increased buffer size for smoother audio

// ============ WHISPER VAD (Voice Activity Detection) ============
// Detects speech segments in audio and sends them to Groq Whisper for transcription.
// This runs in parallel with Gemini audio — Gemini handles the live connection,
// while Whisper provides fast, accurate transcription for Groq/Gemma responses.
let vadState = {
    system: { buffer: [], isSpeaking: false, lastSpeechTime: 0, startTime: 0 },
    mic: { buffer: [], isSpeaking: false, lastSpeechTime: 0, startTime: 0 },
};
let vadSegmentQueue = [];
let vadProcessingLock = false; // prevents overlapping transcription requests
const VAD_SPEECH_THRESHOLD = 250; // RMS threshold for int16 PCM (tuned for system audio loopback)
const VAD_SILENCE_MS = 2000; // silence duration to trigger end-of-speech (2s allows natural mid-question pauses)
const VAD_MIN_SPEECH_MS = 600; // minimum speech duration to avoid noise triggers
const VAD_MAX_SPEECH_MS = 60000; // max 60s segment to prevent memory issues

let hiddenVideo = null;
let offscreenCanvas = null;
let offscreenContext = null;
let currentImageQuality = 'medium'; // Store current image quality for manual screenshots

// ============ SCREENSHOT ACCUMULATION BUFFER ============
// Stores base64 screenshots captured via native OS capture.
// User presses Ctrl+Enter to append frames, Ctrl+Shift+K to force-answer.
let screenshotAccumBuffer = [];
const ACCUMULATION_MAX_FRAMES = 5; // Auto-answer after this many frames

const isLinux = process.platform === 'linux';
const isMacOS = process.platform === 'darwin';

// ============ STORAGE API ============
// Wrapper for IPC-based storage access
const storage = {
    // Config
    async getConfig() {
        const result = await ipcRenderer.invoke('storage:get-config');
        return result.success ? result.data : {};
    },
    async setConfig(config) {
        return ipcRenderer.invoke('storage:set-config', config);
    },
    async updateConfig(key, value) {
        return ipcRenderer.invoke('storage:update-config', key, value);
    },

    // Credentials
    async getCredentials() {
        const result = await ipcRenderer.invoke('storage:get-credentials');
        return result.success ? result.data : {};
    },
    async setCredentials(credentials) {
        return ipcRenderer.invoke('storage:set-credentials', credentials);
    },
    async getApiKey() {
        const result = await ipcRenderer.invoke('storage:get-api-key');
        return result.success ? result.data : '';
    },
    async setApiKey(apiKey) {
        return ipcRenderer.invoke('storage:set-api-key', apiKey);
    },
    async getGroqApiKey() {
        const result = await ipcRenderer.invoke('storage:get-groq-api-key');
        return result.success ? result.data : '';
    },
    async setGroqApiKey(groqApiKey) {
        return ipcRenderer.invoke('storage:set-groq-api-key', groqApiKey);
    },

    // Preferences
    async getPreferences() {
        const result = await ipcRenderer.invoke('storage:get-preferences');
        return result.success ? result.data : {};
    },
    async setPreferences(preferences) {
        return ipcRenderer.invoke('storage:set-preferences', preferences);
    },
    async updatePreference(key, value) {
        return ipcRenderer.invoke('storage:update-preference', key, value);
    },

    // Keybinds
    async getKeybinds() {
        const result = await ipcRenderer.invoke('storage:get-keybinds');
        return result.success ? result.data : null;
    },
    async setKeybinds(keybinds) {
        return ipcRenderer.invoke('storage:set-keybinds', keybinds);
    },

    // Sessions (History)
    async getAllSessions() {
        const result = await ipcRenderer.invoke('storage:get-all-sessions');
        return result.success ? result.data : [];
    },
    async getSession(sessionId) {
        const result = await ipcRenderer.invoke('storage:get-session', sessionId);
        return result.success ? result.data : null;
    },
    async saveSession(sessionId, data) {
        return ipcRenderer.invoke('storage:save-session', sessionId, data);
    },
    async deleteSession(sessionId) {
        return ipcRenderer.invoke('storage:delete-session', sessionId);
    },
    async deleteAllSessions() {
        return ipcRenderer.invoke('storage:delete-all-sessions');
    },

    // Clear all
    async clearAll() {
        return ipcRenderer.invoke('storage:clear-all');
    },

    // Limits
    async getTodayLimits() {
        const result = await ipcRenderer.invoke('storage:get-today-limits');
        return result.success ? result.data : { flash: { count: 0 }, flashLite: { count: 0 } };
    },
};

// Cache for preferences to avoid async calls in hot paths
let preferencesCache = null;

async function loadPreferencesCache() {
    preferencesCache = await storage.getPreferences();
    return preferencesCache;
}

// Initialize preferences cache
loadPreferencesCache();

function convertFloat32ToInt16(float32Array) {
    const int16Array = new Int16Array(float32Array.length);
    for (let i = 0; i < float32Array.length; i++) {
        // Improved scaling to prevent clipping
        const s = Math.max(-1, Math.min(1, float32Array[i]));
        int16Array[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return int16Array;
}

function arrayBufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

function processVAD(int16Array, source = 'system') {
    const state = vadState[source] || vadState.system;

    // Calculate RMS energy
    let sum = 0;
    for (let i = 0; i < int16Array.length; i++) {
        sum += int16Array[i] * int16Array[i];
    }
    const rms = Math.sqrt(sum / int16Array.length);
    const now = Date.now();

    if (rms > VAD_SPEECH_THRESHOLD) {
        if (!state.isSpeaking) {
            state.isSpeaking = true;
            state.startTime = now;
            state.buffer = [];
            console.log(`VAD (${source}): speech started (RMS: ${Math.round(rms)})`);
        }
        state.lastSpeechTime = now;
        for (let i = 0; i < int16Array.length; i++) {
            state.buffer.push(int16Array[i]);
        }
    } else if (state.isSpeaking) {
        for (let i = 0; i < int16Array.length; i++) {
            state.buffer.push(int16Array[i]);
        }

        const silenceDuration = now - state.lastSpeechTime;
        const speechDuration = now - state.startTime;

        if (speechDuration > VAD_MAX_SPEECH_MS) {
            console.log(`VAD (${source}): max duration reached, sending segment`);
            sendVADSegment(source);
            return;
        }

        if (silenceDuration > VAD_SILENCE_MS && speechDuration > VAD_MIN_SPEECH_MS) {
            console.log(`VAD (${source}): speech ended after ${Math.round(speechDuration)}ms`);
            sendVADSegment(source);
        }
    }
}

function sendVADSegment(source = 'system') {
    const state = vadState[source] || vadState.system;
    state.isSpeaking = false;

    if (state.buffer.length === 0) return;
    const audioData = new Int16Array(state.buffer);
    state.buffer = [];

    vadSegmentQueue.push({ audioData, source });
    processNextVadSegment();
}

function processNextVadSegment() {
    if (vadProcessingLock || vadSegmentQueue.length === 0) return;
    vadProcessingLock = true;

    const { audioData, source } = vadSegmentQueue.shift();
    const base64Audio = arrayBufferToBase64(audioData.buffer);
    console.log(`VAD (${source}): sending ${Math.round(audioData.length / SAMPLE_RATE)}s of audio for Whisper transcription`);

    ipcRenderer
        .invoke('whisper-transcribe-respond', base64Audio)
        .then(result => {
            if (result && !result.success) {
                console.warn(`Whisper transcription (${source}) failed:`, result.error);
            }
        })
        .catch(err => {
            console.error(`Whisper transcription IPC error (${source}):`, err);
        })
        .finally(() => {
            vadProcessingLock = false;
            processNextVadSegment();
        });
}

function formatCombinedContext(prefs) {
    let fullContext = prefs.customPrompt || '';
    if (prefs.targetRole || prefs.targetTechStack || prefs.jobDescription) {
        const roleBlock = prefs.targetRole ? `Target Role / Job Title: ${prefs.targetRole}\n` : '';
        const stackBlock = prefs.targetTechStack ? `Required Tech Stack & Keywords: ${prefs.targetTechStack}\n` : '';
        const jdBlock = prefs.jobDescription ? `Job Description & Key Requirements:\n${prefs.jobDescription}\n` : '';
        fullContext = `=== ACTIVE JOB TARGET & INTERVIEW STRATEGY ===
${roleBlock}${stackBlock}${jdBlock}
CORE INSTRUCTION (PROACTIVE FOCUS):
1. By default, frame all general answers, project walkthroughs, and technical examples around the Target Role, Required Tech Stack, and Job Description above. If the interviewer asks an open-ended question (e.g. "Tell me about a challenging project" or "How do you design a scalable API?"), immediately highlight evidence using the Required Tech Stack from your Master Resume below.

SECONDARY INSTRUCTION (RESPONDING TO OTHER STACKS):
2. If the interviewer EXPLICITLY asks about any OTHER tech stack, language, database, or tool not listed in your target stack:
   - ALWAYS answer the technical question directly, accurately, and impressively. Show complete mastery of the concepts!
   - If that technology is mentioned in your Master Resume below, highlight your exact experience with it.
   - If it is unfamiliar or not your primary tool, explain the exact technical mechanics accurately, and then confidently bridge it back to your core expertise in the Required Tech Stack (e.g. "While my primary production focus has been on [Target Stack], the underlying principles in [Asked Stack] are identical when managing...").
==============================================

=== MASTER RESUME & BACKGROUND CONTEXT ===
${fullContext}`;
    }
    return fullContext;
}

async function initializeGemini(profile = 'interview', language = 'en-US') {
    const apiKey = await storage.getApiKey();
    if (apiKey) {
        const prefs = await storage.getPreferences();
        const success = await ipcRenderer.invoke('initialize-gemini', apiKey, formatCombinedContext(prefs), profile, language);
        if (success) {
            cheatingDaddy.setStatus('Live');
        } else {
            cheatingDaddy.setStatus('error');
        }
    }
}

async function initializeLocal(profile = 'interview') {
    const prefs = await storage.getPreferences();
    const ollamaHost = prefs.ollamaHost || 'http://127.0.0.1:11434';
    const ollamaModel = prefs.ollamaModel || 'llama3.1';
    const whisperModel = prefs.whisperModel || 'Xenova/whisper-small';
    const customPrompt = formatCombinedContext(prefs);

    const success = await ipcRenderer.invoke('initialize-local', ollamaHost, ollamaModel, whisperModel, profile, customPrompt);
    if (success) {
        cheatingDaddy.setStatus('Local AI Live');
        return true;
    } else {
        cheatingDaddy.setStatus('error');
        return false;
    }
}

async function initializeCloud(profile = 'interview') {
    const creds = await storage.getCredentials();
    const token = creds.cloudToken;
    if (!token || !token.trim()) {
        cheatingDaddy.setStatus('error');
        return false;
    }

    const prefs = await storage.getPreferences();
    const success = await ipcRenderer.invoke('initialize-cloud', token, profile, formatCombinedContext(prefs));
    if (success) {
        cheatingDaddy.setStatus('Live');
        return true;
    } else {
        cheatingDaddy.setStatus('error');
        return false;
    }
}

// Listen for status updates
ipcRenderer.on('update-status', (event, status) => {
    console.log('Status update:', status);
    cheatingDaddy.setStatus(status);
});

/**
 * Request microphone permission and return list of audio input devices.
 * Calling this triggers the browser permission prompt; after permission is granted,
 * device labels (e.g. "Logitech G733") become available.
 * @returns {Promise<Array<{deviceId: string, label: string}>>}
 */
async function getAudioInputDevices() {
    let stream = null;
    try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        const devices = await navigator.mediaDevices.enumerateDevices();
        return devices
            .filter(d => d.kind === 'audioinput')
            .map(d => ({ deviceId: d.deviceId, label: d.label || `Microphone ${(d.deviceId || '').slice(0, 8)}` }));
    } finally {
        if (stream) stream.getTracks().forEach(t => t.stop());
    }
}

async function startCapture(screenshotIntervalSeconds = 5, imageQuality = 'medium') {
    // Store the image quality for manual screenshots
    currentImageQuality = imageQuality;

    // Refresh preferences cache
    await loadPreferencesCache();
    // Force speaker_only mode to ensure the user's microphone is never captured
    const audioMode = 'speaker_only'; // preferencesCache.audioMode || 'speaker_only';
    const audioInputDeviceId = preferencesCache.audioInputDeviceId || '';

    try {
        if (isMacOS) {
            // On macOS, use SystemAudioDump for audio and getDisplayMedia for screen
            console.log('Starting macOS capture with SystemAudioDump...');

            // Start macOS audio capture
            const audioResult = await ipcRenderer.invoke('start-macos-audio');
            if (!audioResult.success) {
                throw new Error('Failed to start macOS audio capture: ' + audioResult.error);
            }

            // Get screen capture for screenshots
            mediaStream = await navigator.mediaDevices.getDisplayMedia({
                video: {
                    frameRate: 1,
                    width: { ideal: 1920 },
                    height: { ideal: 1080 },
                },
                audio: false, // Don't use browser audio on macOS
            });

            console.log('macOS screen capture started - audio handled by SystemAudioDump');

            if (audioMode === 'mic_only' || audioMode === 'both') {
                let micStream = null;
                try {
                    const micConstraints = {
                        audio: {
                            sampleRate: SAMPLE_RATE,
                            channelCount: 1,
                            echoCancellation: true,
                            noiseSuppression: true,
                            autoGainControl: true,
                            ...(audioInputDeviceId ? { deviceId: { ideal: audioInputDeviceId } } : {}),
                        },
                        video: false,
                    };
                    micStream = await navigator.mediaDevices.getUserMedia(micConstraints);
                    console.log('macOS microphone capture started');
                    setupLinuxMicProcessing(micStream);
                } catch (micError) {
                    console.warn('Failed to get microphone access on macOS:', micError);
                }
            }
        } else if (isLinux) {
            // Linux - use display media for screen capture and try to get system audio
            try {
                // First try to get system audio via getDisplayMedia (works on newer browsers)
                mediaStream = await navigator.mediaDevices.getDisplayMedia({
                    video: {
                        frameRate: 1,
                        width: { ideal: 1920 },
                        height: { ideal: 1080 },
                    },
                    audio: {
                        sampleRate: SAMPLE_RATE,
                        channelCount: 1,
                        echoCancellation: false, // Don't cancel system audio
                        noiseSuppression: false,
                        autoGainControl: false,
                    },
                });

                console.log('Linux system audio capture via getDisplayMedia succeeded');

                // Setup audio processing for Linux system audio
                setupLinuxSystemAudioProcessing();
            } catch (systemAudioError) {
                console.warn('System audio via getDisplayMedia failed, trying screen-only capture:', systemAudioError);

                // Fallback to screen-only capture
                mediaStream = await navigator.mediaDevices.getDisplayMedia({
                    video: {
                        frameRate: 1,
                        width: { ideal: 1920 },
                        height: { ideal: 1080 },
                    },
                    audio: false,
                });
            }

            // Additionally get microphone input for Linux based on audio mode
            if (audioMode === 'mic_only' || audioMode === 'both') {
                let micStream = null;
                try {
                    const micConstraints = {
                        audio: {
                            sampleRate: SAMPLE_RATE,
                            channelCount: 1,
                            echoCancellation: true,
                            noiseSuppression: true,
                            autoGainControl: true,
                            ...(audioInputDeviceId ? { deviceId: { ideal: audioInputDeviceId } } : {}),
                        },
                        video: false,
                    };
                    micStream = await navigator.mediaDevices.getUserMedia(micConstraints);

                    console.log('Linux microphone capture started');

                    // Setup audio processing for microphone on Linux
                    setupLinuxMicProcessing(micStream);
                } catch (micError) {
                    console.warn('Failed to get microphone access on Linux:', micError);
                    // Continue without microphone if permission denied
                }
            }

            console.log('Linux capture started - system audio:', mediaStream.getAudioTracks().length > 0, 'microphone mode:', audioMode);
        } else {
            // Windows - when mic is needed, request microphone first so permission dialog appears on "Start" and device (e.g. G733) is granted
            let micStream = null;
            if (audioMode === 'mic_only' || audioMode === 'both') {
                try {
                    const micConstraints = {
                        audio: {
                            sampleRate: SAMPLE_RATE,
                            channelCount: 1,
                            echoCancellation: true,
                            noiseSuppression: true,
                            autoGainControl: true,
                            ...(audioInputDeviceId ? { deviceId: { ideal: audioInputDeviceId } } : {}),
                        },
                        video: false,
                    };
                    micStream = await navigator.mediaDevices.getUserMedia(micConstraints);
                    console.log('Windows microphone capture started (before display)');
                    setupLinuxMicProcessing(micStream);
                } catch (micError) {
                    console.warn('Failed to get microphone access on Windows:', micError);
                }
            }

            // Then request display (screen ± system audio)
            try {
                mediaStream = await navigator.mediaDevices.getDisplayMedia({
                    video: {
                        frameRate: 1,
                        width: { ideal: 1920 },
                        height: { ideal: 1080 },
                    },
                    audio: {
                        sampleRate: SAMPLE_RATE,
                        channelCount: 1,
                        echoCancellation: true,
                        noiseSuppression: true,
                        autoGainControl: true,
                    },
                });
                console.log('Windows capture started with loopback audio');
                setupWindowsLoopbackProcessing();
            } catch (displayErr) {
                console.warn('getDisplayMedia with audio failed, trying screen only:', displayErr);
                mediaStream = await navigator.mediaDevices.getDisplayMedia({
                    video: {
                        frameRate: 1,
                        width: { ideal: 1920 },
                        height: { ideal: 1080 },
                    },
                    audio: false,
                });
                console.log('Windows capture started (screen only, no system audio)');
            }
        }

        console.log('MediaStream obtained:', {
            hasVideo: mediaStream.getVideoTracks().length > 0,
            hasAudio: mediaStream.getAudioTracks().length > 0,
            videoTrack: mediaStream.getVideoTracks()[0]?.getSettings(),
        });

        // Immediately stop the video track to kill browser telemetry
        // We only requested it because getDisplayMedia requires video to capture audio loopback
        const videoTracks = mediaStream.getVideoTracks();
        if (videoTracks.length > 0) {
            console.log('Stopping video track to minimize telemetry footprint');
            videoTracks.forEach(track => track.stop());
        }

        // Manual mode only - screenshots captured on demand via shortcut
        console.log('Manual mode enabled - screenshots will be captured on demand only');
    } catch (err) {
        console.error('Error starting capture:', err);
        cheatingDaddy.setStatus('error');
    }
}

function setupLinuxMicProcessing(micStream) {
    // Setup microphone audio processing for Linux
    const micAudioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
    const micSource = micAudioContext.createMediaStreamSource(micStream);
    const micProcessor = micAudioContext.createScriptProcessor(BUFFER_SIZE, 1, 1);

    let audioBuffer = [];
    const samplesPerChunk = SAMPLE_RATE * AUDIO_CHUNK_DURATION;

    micProcessor.onaudioprocess = e => {
        const inputData = e.inputBuffer.getChannelData(0);
        audioBuffer.push(...inputData);

        // Process audio in chunks
        while (audioBuffer.length >= samplesPerChunk) {
            const chunk = audioBuffer.splice(0, samplesPerChunk);
            const pcmData16 = convertFloat32ToInt16(chunk);
            const base64Data = arrayBufferToBase64(pcmData16.buffer);

            ipcRenderer
                .invoke('send-mic-audio-content', {
                    data: base64Data,
                    mimeType: 'audio/pcm;rate=24000',
                })
                .catch(() => {});

            // Parallel VAD for Whisper transcription
            processVAD(pcmData16, 'mic');
        }
    };

    micSource.connect(micProcessor);
    micProcessor.connect(micAudioContext.destination);

    // Store processor reference for cleanup
    micAudioProcessor = micProcessor;
}

function setupLinuxSystemAudioProcessing() {
    // Setup system audio processing for Linux (from getDisplayMedia)
    audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
    const source = audioContext.createMediaStreamSource(mediaStream);
    audioProcessor = audioContext.createScriptProcessor(BUFFER_SIZE, 1, 1);

    let audioBuffer = [];
    const samplesPerChunk = SAMPLE_RATE * AUDIO_CHUNK_DURATION;

    audioProcessor.onaudioprocess = e => {
        const inputData = e.inputBuffer.getChannelData(0);
        audioBuffer.push(...inputData);

        // Process audio in chunks
        while (audioBuffer.length >= samplesPerChunk) {
            const chunk = audioBuffer.splice(0, samplesPerChunk);
            const pcmData16 = convertFloat32ToInt16(chunk);
            const base64Data = arrayBufferToBase64(pcmData16.buffer);

            ipcRenderer
                .invoke('send-audio-content', {
                    data: base64Data,
                    mimeType: 'audio/pcm;rate=24000',
                })
                .catch(() => {});

            // Parallel VAD for Whisper transcription
            processVAD(pcmData16, 'system');
        }
    };

    source.connect(audioProcessor);
    audioProcessor.connect(audioContext.destination);
}

function setupWindowsLoopbackProcessing() {
    // Setup audio processing for Windows loopback audio only
    audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
    const source = audioContext.createMediaStreamSource(mediaStream);
    audioProcessor = audioContext.createScriptProcessor(BUFFER_SIZE, 1, 1);

    let audioBuffer = [];
    const samplesPerChunk = SAMPLE_RATE * AUDIO_CHUNK_DURATION;

    audioProcessor.onaudioprocess = e => {
        const inputData = e.inputBuffer.getChannelData(0);
        audioBuffer.push(...inputData);

        // Process audio in chunks
        while (audioBuffer.length >= samplesPerChunk) {
            const chunk = audioBuffer.splice(0, samplesPerChunk);
            const pcmData16 = convertFloat32ToInt16(chunk);
            const base64Data = arrayBufferToBase64(pcmData16.buffer);

            ipcRenderer
                .invoke('send-audio-content', {
                    data: base64Data,
                    mimeType: 'audio/pcm;rate=24000',
                })
                .catch(() => {});

            // Parallel VAD for Whisper transcription
            processVAD(pcmData16, 'system');
        }
    };

    source.connect(audioProcessor);
    audioProcessor.connect(audioContext.destination);
}

async function captureScreenshot(imageQuality = 'medium', isManual = false) {
    console.log(`Capturing ${isManual ? 'manual' : 'automated'} screenshot...`);
    if (!mediaStream) return;

    // Lazy init of video element
    if (!hiddenVideo) {
        hiddenVideo = document.createElement('video');
        hiddenVideo.srcObject = mediaStream;
        hiddenVideo.muted = true;
        hiddenVideo.playsInline = true;
        await hiddenVideo.play();

        await new Promise(resolve => {
            if (hiddenVideo.readyState >= 2) return resolve();
            hiddenVideo.onloadedmetadata = () => resolve();
        });

        // Lazy init of canvas based on video dimensions
        offscreenCanvas = document.createElement('canvas');
        offscreenCanvas.width = hiddenVideo.videoWidth;
        offscreenCanvas.height = hiddenVideo.videoHeight;
        offscreenContext = offscreenCanvas.getContext('2d');
    }

    // Check if video is ready
    if (hiddenVideo.readyState < 2) {
        console.warn('Video not ready yet, skipping screenshot');
        return;
    }

    offscreenContext.drawImage(hiddenVideo, 0, 0, offscreenCanvas.width, offscreenCanvas.height);

    // Check if image was drawn properly by sampling a pixel
    const imageData = offscreenContext.getImageData(0, 0, 1, 1);
    const isBlank = imageData.data.every((value, index) => {
        // Check if all pixels are black (0,0,0) or transparent
        return index === 3 ? true : value === 0;
    });

    if (isBlank) {
        console.warn('Screenshot appears to be blank/black');
    }

    let qualityValue;
    switch (imageQuality) {
        case 'high':
            qualityValue = 0.9;
            break;
        case 'medium':
            qualityValue = 0.7;
            break;
        case 'low':
            qualityValue = 0.5;
            break;
        default:
            qualityValue = 0.7; // Default to medium
    }

    offscreenCanvas.toBlob(
        async blob => {
            if (!blob) {
                console.error('Failed to create blob from canvas');
                return;
            }

            const reader = new FileReader();
            reader.onloadend = async () => {
                const base64data = reader.result.split(',')[1];

                // Validate base64 data
                if (!base64data || base64data.length < 100) {
                    console.error('Invalid base64 data generated');
                    return;
                }

                const prefs = await storage.getPreferences();
                const activeProfile = prefs.selectedProfile || 'interview';
                let prompt = MANUAL_SCREENSHOT_PROMPT;

                const result = await ipcRenderer.invoke('send-image-content', {
                    data: base64data,
                    prompt: prompt,
                    profile: activeProfile,
                });

                if (result.success) {
                    console.log(`Image sent successfully (${offscreenCanvas.width}x${offscreenCanvas.height})`);
                } else {
                    console.error('Failed to send image:', result.error);
                }
            };
            reader.readAsDataURL(blob);
        },
        'image/jpeg',
        qualityValue
    );
}

const MANUAL_SCREENSHOT_PROMPT = `Look at this screen and identify every question being asked, whether it is a multiple choice, coding problem, math problem, written question, or anything else that needs an answer.

For each question you find, answer it directly and completely. Do not summarize the screen or describe what you see. Just answer the questions.

If there is a coding problem, walk through your thinking in a couple bullet points then give the full working code.
If there is an MCQ, state the correct answer and briefly say why.
If there is a written or conceptual question, give a full answer you would actually give.
If there is a math problem, solve it step by step.
If there are multiple questions, answer each one clearly.

Do not start with things like "I can see" or "The screen shows". Just get straight into the answers.`;



async function captureManualScreenshot(imageQuality = null) {
    console.log('Manual screenshot triggered — appending to accumulation buffer');

    try {
        // Use native OS-level capture via main process (invisible to browser telemetry)
        const result = await ipcRenderer.invoke('capture-native-screenshot', {
            quality: 60,
            maxWidth: 1280,
        });

        if (!result.success) {
            console.error('Native screenshot failed:', result.error);
            return;
        }

        const base64data = result.data;
        if (!base64data || base64data.length < 100) {
            console.error('Invalid native screenshot data');
            return;
        }

        // Append to accumulation buffer
        screenshotAccumBuffer.push(base64data);
        const frameCount = screenshotAccumBuffer.length;
        console.log(`Buffer: ${frameCount}/${ACCUMULATION_MAX_FRAMES} frames (${result.width}x${result.height})`);

        // Add visual confirmation to the main panel as requested by user
        cheatingDaddy.addNewResponse(`\u{1F4F8} Captured Screenshot ${frameCount}/${ACCUMULATION_MAX_FRAMES}. (Press Ctrl+Shift+K to solve)`);

        // Update the counter overlay
        updateAccumOverlay(frameCount);

        // Auto-answer if we hit the threshold
        if (frameCount >= ACCUMULATION_MAX_FRAMES) {
            console.log('Max frames reached, auto-triggering answer...');
            await forceAnswerNow();
        }
    } catch (error) {
        console.error('Error in captureManualScreenshot:', error);
    }
}

async function forceAnswerNow() {
    if (screenshotAccumBuffer.length === 0) {
        console.warn('No screenshots buffered, nothing to answer');
        return;
    }

    const images = [...screenshotAccumBuffer];
    screenshotAccumBuffer = [];
    updateAccumOverlay(0);

    // Select prompt based on active profile
    const prefs = await storage.getPreferences();
    const activeProfile = prefs.selectedProfile || 'interview';
    let prompt = MANUAL_SCREENSHOT_PROMPT;

    // Append user's custom instructions so they can specify a language (e.g. "Use JavaScript")
    if (prefs.customPrompt && prefs.customPrompt.trim().length > 0) {
        prompt += `\n\n=== USER CUSTOM INSTRUCTIONS ===\n${prefs.customPrompt.trim()}`;
    }

    console.log(`Force-answering with ${images.length} frame(s), profile: ${activeProfile}`);
    cheatingDaddy.addNewResponse(`⏳ Processing ${images.length} screenshot(s)...`);

    try {
        const result = await ipcRenderer.invoke('send-accumulated-images', {
            images,
            prompt,
            profile: activeProfile,
        });

        if (result.success) {
            console.log(`Accumulated answer completed from ${result.model}`);
        } else {
            console.error('Failed to get accumulated answer:', result.error);
            cheatingDaddy.addNewResponse(`Error: ${result.error}`);
        }
    } catch (error) {
        console.error('Error sending accumulated images:', error);
        cheatingDaddy.addNewResponse(`Error: ${error.message}`);
    }
}

function updateAccumOverlay(count) {
    let overlay = document.getElementById('accum-overlay');
    if (count <= 0) {
        if (overlay) overlay.remove();
        return;
    }
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'accum-overlay';
        overlay.style.cssText =
            'position:fixed;bottom:8px;right:8px;z-index:99999;' +
            'font-size:13px;color:rgba(255,255,255,0.45);' +
            'pointer-events:none;user-select:none;font-family:monospace;';
        document.body.appendChild(overlay);
    }
    overlay.textContent = `\u{1F4F8} ${count}`;
}

// Expose functions to global scope for external access
window.captureManualScreenshot = captureManualScreenshot;
window.forceAnswerNow = forceAnswerNow;

function stopCapture() {
    if (screenshotInterval) {
        clearInterval(screenshotInterval);
        screenshotInterval = null;
    }

    // Reset VAD state
    vadState.system = { isSpeaking: false, buffer: [], startTime: 0, lastSpeechTime: 0 };
    vadState.mic = { isSpeaking: false, buffer: [], startTime: 0, lastSpeechTime: 0 };
    vadSegmentQueue.length = 0;
    vadProcessingLock = false;

    if (audioProcessor) {
        audioProcessor.disconnect();
        audioProcessor = null;
    }

    // Clean up microphone audio processor (Linux only)
    if (micAudioProcessor) {
        micAudioProcessor.disconnect();
        micAudioProcessor = null;
    }

    if (audioContext) {
        audioContext.close();
        audioContext = null;
    }

    if (mediaStream) {
        mediaStream.getTracks().forEach(track => track.stop());
        mediaStream = null;
    }

    // Stop macOS audio capture if running
    if (isMacOS) {
        ipcRenderer.invoke('stop-macos-audio').catch(err => {
            console.error('Error stopping macOS audio:', err);
        });
    }

    // Clean up hidden elements
    if (hiddenVideo) {
        hiddenVideo.pause();
        hiddenVideo.srcObject = null;
        hiddenVideo = null;
    }
    offscreenCanvas = null;
    offscreenContext = null;
}

// Send text message via the RAG pipeline (knowledge-base lookup + Gemini)
async function sendTextMessage(text) {
    if (!text || text.trim().length === 0) {
        console.warn('Cannot send empty text message');
        return { success: false, error: 'Empty message' };
    }

    try {
        // 'send-rag-question' retrieves relevant docs from the vector store,
        // injects them into the prompt, then forwards to the active AI provider.
        const result = await ipcRenderer.invoke('send-rag-question', text);
        if (result.success) {
            console.log('RAG-augmented text message sent successfully');
        } else {
            console.error('Failed to send RAG-augmented text message:', result.error);
        }
        return result;
    } catch (error) {
        console.error('Error sending RAG-augmented text message:', error);
        return { success: false, error: error.message };
    }
}

// Listen for conversation data from main process and save to storage
ipcRenderer.on('save-conversation-turn', async (event, data) => {
    try {
        await storage.saveSession(data.sessionId, { conversationHistory: data.fullHistory });
        console.log('Conversation session saved:', data.sessionId);
    } catch (error) {
        console.error('Error saving conversation session:', error);
    }
});

// Listen for session context (profile info) when session starts
ipcRenderer.on('save-session-context', async (event, data) => {
    try {
        await storage.saveSession(data.sessionId, {
            profile: data.profile,
            customPrompt: data.customPrompt,
        });
        console.log('Session context saved:', data.sessionId, 'profile:', data.profile);
    } catch (error) {
        console.error('Error saving session context:', error);
    }
});

// Listen for screen analysis responses (from ctrl+enter)
ipcRenderer.on('save-screen-analysis', async (event, data) => {
    try {
        await storage.saveSession(data.sessionId, {
            screenAnalysisHistory: data.fullHistory,
            profile: data.profile,
            customPrompt: data.customPrompt,
        });
        console.log('Screen analysis saved:', data.sessionId);
    } catch (error) {
        console.error('Error saving screen analysis:', error);
    }
});

// Listen for emergency erase command from main process
ipcRenderer.on('clear-sensitive-data', async () => {
    console.log('Clearing all data...');
    await storage.clearAll();
});

// Handle shortcuts based on current view
function handleShortcut(shortcutKey) {
    const currentView = cheatingDaddy.getCurrentView();

    if (shortcutKey === 'ctrl+enter' || shortcutKey === 'cmd+enter') {
        if (currentView === 'main') {
            cheatingDaddy.element().handleStart();
        } else {
            captureManualScreenshot();
        }
    }
}

// Create reference to the main app element
const cheatingDaddyApp = document.querySelector('cheating-daddy-app');

// ============ THEME SYSTEM ============
const theme = {
    themes: {
        dark: {
            background: '#101010',
            text: '#e0e0e0',
            textSecondary: '#a0a0a0',
            textMuted: '#6b6b6b',
            border: '#2a2a2a',
            accent: '#ffffff',
            btnPrimaryBg: '#ffffff',
            btnPrimaryText: '#000000',
            btnPrimaryHover: '#e0e0e0',
            tooltipBg: '#1a1a1a',
            tooltipText: '#ffffff',
            keyBg: 'rgba(255,255,255,0.1)',
        },
        light: {
            background: '#ffffff',
            text: '#1a1a1a',
            textSecondary: '#555555',
            textMuted: '#888888',
            border: '#e0e0e0',
            accent: '#000000',
            btnPrimaryBg: '#1a1a1a',
            btnPrimaryText: '#ffffff',
            btnPrimaryHover: '#333333',
            tooltipBg: '#1a1a1a',
            tooltipText: '#ffffff',
            keyBg: 'rgba(0,0,0,0.1)',
        },
        midnight: {
            background: '#0d1117',
            text: '#c9d1d9',
            textSecondary: '#8b949e',
            textMuted: '#6e7681',
            border: '#30363d',
            accent: '#58a6ff',
            btnPrimaryBg: '#58a6ff',
            btnPrimaryText: '#0d1117',
            btnPrimaryHover: '#79b8ff',
            tooltipBg: '#161b22',
            tooltipText: '#c9d1d9',
            keyBg: 'rgba(88,166,255,0.15)',
        },
        sepia: {
            background: '#f4ecd8',
            text: '#5c4b37',
            textSecondary: '#7a6a56',
            textMuted: '#998875',
            border: '#d4c8b0',
            accent: '#8b4513',
            btnPrimaryBg: '#5c4b37',
            btnPrimaryText: '#f4ecd8',
            btnPrimaryHover: '#7a6a56',
            tooltipBg: '#5c4b37',
            tooltipText: '#f4ecd8',
            keyBg: 'rgba(92,75,55,0.15)',
        },
        catppuccin: {
            background: '#1e1e2e',
            text: '#cdd6f4',
            textSecondary: '#a6adc8',
            textMuted: '#585b70',
            border: '#313244',
            accent: '#cba6f7',
            btnPrimaryBg: '#cba6f7',
            btnPrimaryText: '#1e1e2e',
            btnPrimaryHover: '#b4befe',
            tooltipBg: '#313244',
            tooltipText: '#cdd6f4',
            keyBg: 'rgba(203,166,247,0.12)',
        },
        gruvbox: {
            background: '#1d2021',
            text: '#ebdbb2',
            textSecondary: '#a89984',
            textMuted: '#665c54',
            border: '#3c3836',
            accent: '#fe8019',
            btnPrimaryBg: '#fe8019',
            btnPrimaryText: '#1d2021',
            btnPrimaryHover: '#fabd2f',
            tooltipBg: '#3c3836',
            tooltipText: '#ebdbb2',
            keyBg: 'rgba(254,128,25,0.12)',
        },
        rosepine: {
            background: '#191724',
            text: '#e0def4',
            textSecondary: '#908caa',
            textMuted: '#6e6a86',
            border: '#26233a',
            accent: '#ebbcba',
            btnPrimaryBg: '#ebbcba',
            btnPrimaryText: '#191724',
            btnPrimaryHover: '#f6c177',
            tooltipBg: '#26233a',
            tooltipText: '#e0def4',
            keyBg: 'rgba(235,188,186,0.12)',
        },
        solarized: {
            background: '#002b36',
            text: '#93a1a1',
            textSecondary: '#839496',
            textMuted: '#586e75',
            border: '#073642',
            accent: '#2aa198',
            btnPrimaryBg: '#2aa198',
            btnPrimaryText: '#002b36',
            btnPrimaryHover: '#268bd2',
            tooltipBg: '#073642',
            tooltipText: '#93a1a1',
            keyBg: 'rgba(42,161,152,0.12)',
        },
        tokyonight: {
            background: '#1a1b26',
            text: '#c0caf5',
            textSecondary: '#9aa5ce',
            textMuted: '#565f89',
            border: '#292e42',
            accent: '#7aa2f7',
            btnPrimaryBg: '#7aa2f7',
            btnPrimaryText: '#1a1b26',
            btnPrimaryHover: '#bb9af7',
            tooltipBg: '#292e42',
            tooltipText: '#c0caf5',
            keyBg: 'rgba(122,162,247,0.12)',
        },
    },

    current: 'dark',

    get(name) {
        return this.themes[name] || this.themes.dark;
    },

    getAll() {
        const names = {
            dark: 'Dark',
            light: 'Light',
            midnight: 'Midnight Blue',
            sepia: 'Sepia',
            catppuccin: 'Catppuccin Mocha',
            gruvbox: 'Gruvbox Dark',
            rosepine: 'Ros\u00e9 Pine',
            solarized: 'Solarized Dark',
            tokyonight: 'Tokyo Night',
        };
        return Object.keys(this.themes).map(key => ({
            value: key,
            name: names[key] || key,
            colors: this.themes[key],
        }));
    },

    hexToRgb(hex) {
        const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
        return result
            ? {
                  r: parseInt(result[1], 16),
                  g: parseInt(result[2], 16),
                  b: parseInt(result[3], 16),
              }
            : { r: 30, g: 30, b: 30 };
    },

    lightenColor(rgb, amount) {
        return {
            r: Math.min(255, rgb.r + amount),
            g: Math.min(255, rgb.g + amount),
            b: Math.min(255, rgb.b + amount),
        };
    },

    darkenColor(rgb, amount) {
        return {
            r: Math.max(0, rgb.r - amount),
            g: Math.max(0, rgb.g - amount),
            b: Math.max(0, rgb.b - amount),
        };
    },

    applyBackgrounds(backgroundColor, alpha = 0.8) {
        const root = document.documentElement;
        const baseRgb = this.hexToRgb(backgroundColor);

        // For light themes, darken; for dark themes, lighten
        const isLight = (baseRgb.r + baseRgb.g + baseRgb.b) / 3 > 128;
        const adjust = isLight ? this.darkenColor.bind(this) : this.lightenColor.bind(this);

        const secondary = adjust(baseRgb, 10);
        const tertiary = adjust(baseRgb, 22);
        const hover = adjust(baseRgb, 28);

        const bgBase = `rgba(${baseRgb.r}, ${baseRgb.g}, ${baseRgb.b}, ${alpha})`;
        const bgSurface = `rgba(${secondary.r}, ${secondary.g}, ${secondary.b}, ${alpha})`;
        const bgElevated = `rgba(${tertiary.r}, ${tertiary.g}, ${tertiary.b}, ${alpha})`;
        const bgHover = `rgba(${hover.r}, ${hover.g}, ${hover.b}, ${alpha})`;

        // New design tokens (used by components)
        root.style.setProperty('--bg-app', bgBase);
        root.style.setProperty('--bg-surface', bgSurface);
        root.style.setProperty('--bg-elevated', bgElevated);
        root.style.setProperty('--bg-hover', bgHover);

        // Legacy aliases
        root.style.setProperty('--header-background', bgBase);
        root.style.setProperty('--main-content-background', bgBase);
        root.style.setProperty('--bg-primary', bgBase);
        root.style.setProperty('--bg-secondary', bgSurface);
        root.style.setProperty('--bg-tertiary', bgElevated);
        root.style.setProperty('--input-background', bgElevated);
        root.style.setProperty('--input-focus-background', bgElevated);
        root.style.setProperty('--hover-background', bgHover);
        root.style.setProperty('--scrollbar-background', bgBase);
    },

    apply(themeName, alpha = 0.8) {
        const colors = this.get(themeName);
        this.current = themeName;
        const root = document.documentElement;

        // New design tokens (used by components)
        root.style.setProperty('--text-primary', colors.text);
        root.style.setProperty('--text-secondary', colors.textSecondary);
        root.style.setProperty('--text-muted', colors.textMuted);
        root.style.setProperty('--border', colors.border);
        root.style.setProperty('--border-strong', colors.accent);
        root.style.setProperty('--accent', colors.btnPrimaryBg);
        root.style.setProperty('--accent-hover', colors.btnPrimaryHover);

        // Legacy aliases
        root.style.setProperty('--text-color', colors.text);
        root.style.setProperty('--border-color', colors.border);
        root.style.setProperty('--border-default', colors.accent);
        root.style.setProperty('--placeholder-color', colors.textMuted);
        root.style.setProperty('--scrollbar-thumb', colors.border);
        root.style.setProperty('--scrollbar-thumb-hover', colors.textMuted);
        root.style.setProperty('--key-background', colors.keyBg);
        // Primary button
        root.style.setProperty('--btn-primary-bg', colors.btnPrimaryBg);
        root.style.setProperty('--btn-primary-text', colors.btnPrimaryText);
        root.style.setProperty('--btn-primary-hover', colors.btnPrimaryHover);
        // Start button (same as primary)
        root.style.setProperty('--start-button-background', colors.btnPrimaryBg);
        root.style.setProperty('--start-button-color', colors.btnPrimaryText);
        root.style.setProperty('--start-button-hover-background', colors.btnPrimaryHover);
        // Tooltip
        root.style.setProperty('--tooltip-bg', colors.tooltipBg);
        root.style.setProperty('--tooltip-text', colors.tooltipText);
        // Error color (stays constant)
        root.style.setProperty('--error-color', '#f14c4c');
        root.style.setProperty('--success-color', '#4caf50');

        // Also apply background colors from theme
        this.applyBackgrounds(colors.background, alpha);
    },

    async load() {
        try {
            const prefs = await storage.getPreferences();
            const themeName = prefs.theme || 'dark';
            const alpha = prefs.backgroundTransparency ?? 0.8;
            this.apply(themeName, alpha);
            return themeName;
        } catch (err) {
            this.apply('dark');
            return 'dark';
        }
    },

    async save(themeName) {
        await storage.updatePreference('theme', themeName);
        this.apply(themeName);
    },
};

// Consolidated cheatingDaddy object - all functions in one place
const cheatingDaddy = {
    // App version
    getVersion: async () => ipcRenderer.invoke('get-app-version'),

    // Element access
    element: () => cheatingDaddyApp,
    e: () => cheatingDaddyApp,

    // App state functions - access properties directly from the app element
    getCurrentView: () => cheatingDaddyApp.currentView,
    getLayoutMode: () => cheatingDaddyApp.layoutMode,

    // Status and response functions
    setStatus: text => cheatingDaddyApp.setStatus(text),
    addNewResponse: response => cheatingDaddyApp.addNewResponse(response),
    updateCurrentResponse: response => cheatingDaddyApp.updateCurrentResponse(response),

    // Core functionality
    initializeGemini,
    initializeCloud,
    initializeLocal,
    startCapture,
    stopCapture,
    sendTextMessage,
    handleShortcut,
    getAudioInputDevices,

    // Storage API
    storage,

    // Theme API
    theme,

    // Refresh preferences cache (call after updating preferences)
    refreshPreferencesCache: loadPreferencesCache,

    // Platform detection
    isLinux: isLinux,
    isMacOS: isMacOS,
};

// Make it globally available
window.cheatingDaddy = cheatingDaddy;
window.kalengh = cheatingDaddy;

// Load theme after DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => theme.load());
} else {
    theme.load();
}
