// パスワード変更の入力条件（画面と API で共通）。ブラウザにも読み込まれるので Supabase クライアントは import しない
export const PASSWORD_MIN_LENGTH = 8
// Supabase Auth（bcrypt）が受け付ける上限。文字数ではなく UTF-8 のバイト数
export const PASSWORD_MAX_BYTES = 72
