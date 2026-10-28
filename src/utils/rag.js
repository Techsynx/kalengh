// src/utils/rag.js
// Retrieval-Augmented Generation using Gemini text-embedding-004 for semantic search.
// Supports .md, .txt, and .pdf files in the knowledge base.
// Falls back to keyword overlap scoring if embeddings are unavailable.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getKnowledgeBaseDir, getEmbeddingsCachePath, getApiKey } = require('../storage');

let embeddingsCache = null;

// ─── Cache helpers ────────────────────────────────────────────────────────────

function loadCache() {
    if (embeddingsCache) return embeddingsCache;
    const cachePath = getEmbeddingsCachePath();
    try {
        const raw = fs.readFileSync(cachePath, 'utf8');
        embeddingsCache = JSON.parse(raw);
    } catch (e) {
        embeddingsCache = { documents: [], vectors: [] };
    }
    return embeddingsCache;
}

function saveCache() {
    const cachePath = getEmbeddingsCachePath();
    const dir = path.dirname(cachePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(embeddingsCache, null, 2), 'utf8');
}

function hashText(text) {
    return crypto.createHash('sha256').update(text).digest('hex');
}

// ─── PDF text extraction ──────────────────────────────────────────────────────

async function extractPdfText(filePath) {
    try {
        const pdfParse = require('pdf-parse');
        const buffer = fs.readFileSync(filePath);
        const data = await pdfParse(buffer);
        return data.text || '';
    } catch (err) {
        console.warn(`Failed to parse PDF ${path.basename(filePath)}:`, err.message);
        return '';
    }
}

// ─── Chunking ─────────────────────────────────────────────────────────────────
// Split large documents into overlapping 800-char chunks so embeddings are
// granular enough to match specific sections of a long resume or notes file.

const CHUNK_SIZE = 800;
const CHUNK_OVERLAP = 150;

function chunkText(text) {
    const chunks = [];
    let start = 0;
    while (start < text.length) {
        const end = Math.min(start + CHUNK_SIZE, text.length);
        chunks.push(text.slice(start, end).trim());
        if (end === text.length) break;
        start += CHUNK_SIZE - CHUNK_OVERLAP;
    }
    return chunks.filter(c => c.length > 50); // skip tiny chunks
}

// ─── Embedding API ────────────────────────────────────────────────────────────

async function embedWithApi(text, apiKey) {
    const url = `https://generativelanguage.googleapis.com/v1/models/text-embedding-004:embedContent?key=${apiKey}`;
    const body = { content: { parts: [{ text }] } };
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!response.ok) {
        const err = await response.text();
        throw new Error(`Embedding API ${response.status}: ${err}`);
    }
    const data = await response.json();
    return data.embedding.values;
}

async function getEmbedding(text) {
    const key = getApiKey();
    if (!key || !key.trim()) throw new Error('No Gemini API key for embeddings');
    // Use first key if comma-separated
    const firstKey = key
        .split(/[,;\s]+/)
        .map(k => k.trim())
        .filter(Boolean)[0];
    return embedWithApi(text, firstKey);
}

// ─── Index builder ────────────────────────────────────────────────────────────

async function buildIndex() {
    const kbDir = getKnowledgeBaseDir();
    if (!fs.existsSync(kbDir)) {
        console.warn('Knowledge-base directory missing — RAG disabled');
        return;
    }

    const SUPPORTED = ['.md', '.txt', '.pdf'];
    const files = fs.readdirSync(kbDir).filter(f => SUPPORTED.includes(path.extname(f).toLowerCase()));
    const cache = loadCache();
    let changed = false;

    for (const file of files) {
        const filePath = path.join(kbDir, file);
        const stat = fs.statSync(filePath);
        const fileId = hashText(filePath + stat.mtimeMs);

        // Skip if already indexed with same mtime hash
        const alreadyCached = cache.documents.some(d => d.fileId === fileId);
        if (alreadyCached) continue;

        // Remove stale entries for this file path
        cache.documents = cache.documents.filter(d => d.path !== filePath);
        cache.vectors = cache.vectors.filter((_, i) => cache.documents[i]?.path !== filePath);

        // Read content
        let rawText = '';
        if (path.extname(file).toLowerCase() === '.pdf') {
            rawText = await extractPdfText(filePath);
        } else {
            rawText = fs.readFileSync(filePath, 'utf8');
        }

        if (!rawText.trim()) {
            console.warn(`Skipping empty file: ${file}`);
            continue;
        }

        // Chunk into segments
        const chunks = chunkText(rawText);
        console.log(`Indexing ${file} → ${chunks.length} chunk(s)`);

        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            const chunkId = hashText(filePath + i);

            let vector = null;
            try {
                vector = await getEmbedding(chunk);
            } catch (err) {
                console.warn(`Embedding failed for ${file} chunk ${i}: ${err.message} — will use keyword fallback`);
            }

            cache.documents.push({
                id: chunkId,
                fileId,
                path: filePath,
                chunkIndex: i,
                text: chunk,
            });

            cache.vectors.push(vector); // may be null if embedding failed
        }

        changed = true;
    }

    if (!Array.isArray(cache.vectors)) cache.vectors = [];
    if (changed) saveCache();
}

// ─── Similarity ───────────────────────────────────────────────────────────────

function cosine(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0,
        magA = 0,
        magB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        magA += a[i] * a[i];
        magB += b[i] * b[i];
    }
    return magA && magB ? dot / (Math.sqrt(magA) * Math.sqrt(magB)) : 0;
}

function keywordScore(query, docText) {
    const queryWords = query.toLowerCase().split(/\s+/).filter(Boolean);
    const docWords = new Set(docText.toLowerCase().split(/\s+/));
    return queryWords.reduce((sum, w) => sum + (docWords.has(w) ? 1 : 0), 0);
}

// ─── Search ───────────────────────────────────────────────────────────────────

async function search(query, topK = 3) {
    const cache = loadCache();
    if (cache.documents.length === 0) await buildIndex();

    return (await getRelevantDocs(query, topK)).map(doc => `---\nSource: ${path.basename(doc.path)}\n${doc.text.slice(0, 2500)}\n---`).join('\n');
}

function isDocForDifferentRole(filePath, targetRole) {
    if (!targetRole) return false;
    const name = path.basename(filePath).toLowerCase();
    const role = targetRole.toLowerCase();

    // Common role terms
    const isAiTarget = role.includes('ai') || role.includes('ml') || role.includes('machine learning');
    const isFullstackTarget = role.includes('full') || role.includes('fs');
    const isFrontendTarget = role.includes('front') || role.includes('fe');
    const isBackendTarget = role.includes('back') || role.includes('be');

    const isAiDoc = name.includes('ai') || name.includes('machine') || name.includes('ml');
    const isFullstackDoc = name.includes('fullstack') || name.includes('full-stack');
    const isFrontendDoc = name.includes('frontend') || name.includes('front-end');
    const isBackendDoc = name.includes('backend') || name.includes('back-end');

    // If target is fullstack/frontend/backend, but doc is AI specific, exclude/deprioritize it
    if (!isAiTarget && isAiDoc) return true;
    // If target is AI/ML, but doc is Fullstack/Frontend/Backend specific, exclude/deprioritize it
    if (isAiTarget && (isFullstackDoc || isFrontendDoc || isBackendDoc)) return true;
    // If target is frontend, but doc is backend specific, exclude/deprioritize it
    if (isFrontendTarget && isBackendDoc) return true;
    // If target is backend, but doc is frontend specific, exclude/deprioritize it
    if (isBackendTarget && isFrontendDoc) return true;

    return false;
}

async function getRelevantDocs(query, topK = 3) {
    const cache = loadCache();
    if (cache.documents.length === 0) await buildIndex();
    if (cache.documents.length === 0) return [];

    // Get current target role to filter/weight documents
    let targetRole = '';
    try {
        const storage = require('../storage');
        const prefs = storage.getPreferences();
        targetRole = prefs.targetRole || '';
    } catch (e) {}

    // Check if we have any real embeddings
    const hasEmbeddings = cache.vectors.some(v => v !== null && Array.isArray(v) && v.length > 0);

    let scores;

    if (hasEmbeddings) {
        // Semantic search via cosine similarity
        let queryVector = null;
        try {
            queryVector = await getEmbedding(query);
        } catch (err) {
            console.warn('Query embedding failed, using keyword fallback:', err.message);
        }

        if (queryVector) {
            scores = cache.documents.map((doc, i) => ({
                idx: i,
                score: cosine(queryVector, cache.vectors[i]),
            }));
        } else {
            // Embedding failed at query time — fallback
            scores = cache.documents.map((doc, i) => ({
                idx: i,
                score: keywordScore(query, doc.text),
            }));
        }
    } else {
        // No embeddings at all — keyword fallback
        scores = cache.documents.map((doc, i) => ({
            idx: i,
            score: keywordScore(query, doc.text),
        }));
    }

    // Apply role-based filtering and deprioritize mismatched files
    const scoredDocs = scores.map(s => {
        const doc = cache.documents[s.idx];
        if (isDocForDifferentRole(doc.path, targetRole)) {
            return { ...s, score: s.score * 0.01 }; // Heavily penalize mismatch
        }
        return s;
    });

    scoredDocs.sort((a, b) => b.score - a.score);

    const MIN_SCORE = hasEmbeddings ? 0.3 : 1; // cosine ≥ 0.3 is semantically related
    const hits = scoredDocs
        .filter(s => s.score >= MIN_SCORE)
        .slice(0, topK)
        .map(s => cache.documents[s.idx]);

    console.log(`🔎 RAG — query: "${query.substring(0, 60)}" → ${hits.length} chunk(s) matched (${hasEmbeddings ? 'semantic' : 'keyword'} mode)`);
    hits.forEach(h => console.log(`   📄 ${path.basename(h.path)} chunk ${h.chunkIndex}`));

    return hits;
}

module.exports = { buildIndex, search, getRelevantDocs };
