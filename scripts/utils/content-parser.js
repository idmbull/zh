// scripts/utils/content-parser.js
import { convertMarkdownToPlain } from "../utils.js";

const TIMESTAMP_REGEX = /^([\d.]+)\s+([\d.]+)/;

// [HÀM MỚI] Kiểm tra ký tự CJK (Trung/Nhật/Hàn) và dấu câu toàn khổ
// \u3000-\u303f: Dấu câu CJK
// \uff00-\uffef: Dấu câu Fullwidth (bao gồm dấu phẩy ，)
// \u4e00-\u9fa5: Chữ Hán
// \uac00-\ud7af: Tiếng Hàn (Hangul)
function isCJK(char) {
    if (!char) return false;
    return /[\u3000-\u303f\uff00-\uffef\u4e00-\u9fa5\uac00-\ud7af]/.test(char);
}

// Hàm làm sạch cơ bản cho metadata
function cleanText(text) {
    if (!text) return "";
    return text
        .replace(/&nbsp;/gi, " ")
        .replace(/\u00A0/g, " ")
        .replace(/[‘’]/g, "'")
        // .replace(/[“”]/g, "\"")
        .replace(/[—–]/g, "-")
        .replace(/ …/g, "...")
        .replace(/…/g, "...")
        .replace(/\u200B/g, "");
}

// [REFACTOR] Hàm làm sạch dành riêng cho nội dung gõ (Typing Engine)
function cleanForTyping(text) {
    if (!text) return "";

    let s = text;

    // 1. Loại bỏ Footnote: ^[note] trước để tránh xử lý nhầm bên trong
    s = s.replace(/\^\[[^\]]+\]/g, '');

    // 2. Loại bỏ Skipped Text: `content`
    // Thay thế bằng chuỗi rỗng, giữ nguyên khoảng trắng xung quanh nó
    s = s.replace(/`[^`]+`/g, '');

    // 3. Loại bỏ định dạng Markdown
    s = s.replace(/[*_~]+/g, '');

    // 4. Thay thế các ký tự xuống dòng/tab bằng dấu cách
    s = s.replace(/[\r\n\t]+/g, ' ');

    // 5. Gộp nhiều dấu cách liên tiếp thành 1 
    // QUAN TRỌNG: Không dùng trim() ở đây để bảo toàn khoảng trắng dẫn đầu/cuối của fragment
    s = s.replace(/\s+/g, ' ');

    return s;
}

function escapeAttr(s) {
    if (!s) return "";
    return s.replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

export function parseUnified(rawContent) {
    const lines = rawContent.split(/\r?\n/);
    const result = {
        title: "",
        text: "",
        html: "",
        segments: [],
        charStarts: [],
        rawLength: 0
    };

    let blocks = [];
    let isDictation = lines.some(line => TIMESTAMP_REGEX.test(line.trim()));

    // BƯỚC 1: Phân tách Blocks
    lines.forEach(line => {
        const trimmed = line.trim();
        // Giữ lại dòng trống để tạo paragraph break
        if (!trimmed) {
            if (blocks.length > 0 && blocks[blocks.length - 1].type !== 'break') {
                blocks.push({ type: 'break' });
            }
            return;
        }

        if (trimmed.startsWith("# ")) {
            result.title = cleanText(trimmed.replace("#", "").trim());
            return;
        }

        if (trimmed.startsWith("##")) {
            blocks.push({ type: 'header', content: cleanText(trimmed.replace(/^#+\s*/, "")) });
        } else if (isDictation && TIMESTAMP_REGEX.test(trimmed)) {
            blocks.push(parseDictationLine(trimmed));
        } else {
            blocks.push({ type: 'paragraph', content: cleanText(trimmed) });
        }
    });

    // BƯỚC 2: Lắp ráp dữ liệu (Assemble)
    assembleData(blocks, result);

    // BƯỚC 3: Chuẩn hóa lần cuối
    if (result.text) {
        result.text = result.text.trimEnd();
    }

    return result;
}

function parseDictationLine(line) {
    const parts = line.split("\t");
    let start = 0, end = 0, speaker = null, textRaw = "";

    if (parts.length >= 4) {
        start = parseFloat(parts[0]); end = parseFloat(parts[1]);
        speaker = parts[2].trim(); textRaw = parts.slice(3).join(" ").trim();
    } else {
        const m = line.match(/^([\d.]+)\s+([\d.]+)\s+(.*)$/);
        if (m) { start = parseFloat(m[1]); end = parseFloat(m[2]); textRaw = m[3].trim(); }
        else textRaw = line;
    }
    return { type: 'audio', start, end, speaker: cleanText(speaker), content: cleanText(textRaw) };
}

function formatHtmlContent(text) {
    const makeSpan = (word, note) => {
        const cleanWord = convertMarkdownToPlain(word);
        return `<span class="tooltip-word" data-note="${escapeAttr(note)}">${cleanWord}</span>`;
    };

    return text
        .replace(/`([^`]+)`/g, '<span class="skipped-text">$1</span>')
        .replace(/\*\*(.+?)\*\*\^\[([^\]]+)\]/g, (m, w, n) => makeSpan(w, n))
        .replace(/([.,;!?])\^\[([^\]]+)\]/g, (m, c, n) => makeSpan(c, n))
        .replace(/([^\s.,;!?\[\]\^]+)\^\[([^\]]+)\]/g, (m, w, n) => makeSpan(w, n))
        .replace(/\*\*(.+?)\*\*/g, "$1")
        .replace(/\*(.+?)\*/g, "$1")
        .replace(/__(.+?)__/g, "$1")
        .replace(/_(.+?)_/g, "$1");
}

function assembleData(blocks, result) {
    let currentParagraphHtml = "";
    let lastBlockWasBreak = false;

    // [HÀM SỬA LỖI] Biến theo dõi ký tự cuối của khối nội dung trước đó trong cùng đoạn
    // Dùng để quyết định việc thêm dấu cách trong HTML
    let lastRawChar = null;

    const flushParagraph = () => {
        if (currentParagraphHtml) {
            result.html += `<p>${currentParagraphHtml}</p>`;
            result.html += '<span class="newline-char">↵</span>';
            currentParagraphHtml = "";
            lastRawChar = null; // Reset khi qua đoạn mới
        }
    };

    blocks.forEach((block) => {
        if (block.type === 'header' || block.type === 'break') {
            flushParagraph();
            if (block.type === 'header') {
                result.html += `<h3 class="visual-header">${block.content}</h3>`;
            }
            lastBlockWasBreak = true;
            return;
        }

        // --- 1. XỬ LÝ TEXT CHO TYPING ENGINE (result.text) ---
        const cleanFragment = cleanForTyping(block.content);
        const hasTypingContent = cleanFragment.length > 0 && cleanFragment.trim().length > 0;
        const isSkippedLine = !hasTypingContent && block.content.trim().length > 0;

        if (hasTypingContent) {
            let prefix = "";
            if (result.text.length > 0) {
                const endsWithSpace = result.text.endsWith(" ");
                const startsWithSpace = cleanFragment.startsWith(" ");

                if (!endsWithSpace && !startsWithSpace) {
                    prefix = " "; // Mặc định thêm dấu cách

                    // Nếu không phải là ngắt đoạn, kiểm tra CJK để xóa dấu cách
                    if (!lastBlockWasBreak) {
                        const lastChar = result.text[result.text.length - 1];
                        const firstChar = cleanFragment[0];
                        if (isCJK(lastChar) && isCJK(firstChar)) {
                            prefix = "";
                        }
                    }
                }
            }

            result.charStarts.push(result.text.length + prefix.length);
            result.text += prefix + cleanFragment;

            if (block.type === 'audio') {
                result.segments.push({
                    audioStart: block.start,
                    audioEnd: block.end,
                    text: cleanFragment.trim()
                });
            }
            lastBlockWasBreak = false;
        }
        else if (isSkippedLine) {
            if (result.text.length > 0 && !result.text.endsWith(" ")) {
                result.text += " ";
            }
            lastBlockWasBreak = false;
        }

        // --- 2. XỬ LÝ HIỂN THỊ HTML (result.html) ---
        const speakerHtml = block.speaker ? `<span class="speaker-label">${block.speaker}: </span>` : "";
        const contentHtml = formatHtmlContent(block.content);

        let htmlPrefix = "";

        // Logic nối chuỗi cho HTML
        if (currentParagraphHtml) {
            htmlPrefix = " "; // Mặc định có dấu cách

            // Nếu có ký tự trước đó, kiểm tra CJK để xóa dấu cách
            if (lastRawChar && block.content) {
                const firstChar = block.content[0];

                // Chỉ xóa dấu cách nếu không có speaker label (vì label cần tách biệt)
                // và cả 2 ký tự giáp ranh đều là CJK
                if (!block.speaker && isCJK(lastRawChar) && isCJK(firstChar)) {
                    htmlPrefix = "";
                }
            }
        }

        currentParagraphHtml += `${htmlPrefix}${speakerHtml}${contentHtml}`;

        // Cập nhật ký tự cuối cùng để dùng cho vòng lặp sau
        if (block.content && block.content.length > 0) {
            lastRawChar = block.content[block.content.length - 1];
        }
    });

    flushParagraph();

    if (result.html.endsWith('<span class="newline-char">↵</span>')) {
        result.html = result.html.slice(0, -'<span class="newline-char">↵</span>'.length);
    }
}