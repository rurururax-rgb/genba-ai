/**
 * RAGZ v1 Trial の UI 公開範囲。
 *
 * 自由チャットは Trial のお客様向け UI に入口を出さない（「AIに質問してください」ではなく
 * 「RAGZが先に確認しておきました」を主にするため）。
 * /api/ai/chat・ChatPanel・CompanyChat・AI Tool 群は将来の AI 事務員基盤として残し、
 * ここを true に戻せば入口が復活する。
 */
export const CHAT_ENTRY_ENABLED = false
