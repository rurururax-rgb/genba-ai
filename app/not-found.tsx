// 存在しない URL を開いたときの画面（Next.js 標準の英語 404 を出さない）
import Link from 'next/link'
import { Button } from '@/components/ui/button'

export default function NotFound() {
  return (
    <main className="flex min-h-[70vh] flex-col items-center justify-center gap-4 px-6 text-center">
      <h1 className="text-lg font-semibold text-[#1A2E24]">ページが見つかりません</h1>
      <p className="text-sm text-[#47564E]">URL が変更されたか、削除された可能性があります。</p>
      <Button asChild variant="primary"><Link href="/projects">案件一覧へ戻る</Link></Button>
    </main>
  )
}
