'use client'

// 予期しない例外が起きたときの画面（Next.js 標準の英語エラー画面を出さない）
import { useEffect } from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error('[app/error]', error)
  }, [error])

  return (
    <main className="flex min-h-[70vh] flex-col items-center justify-center gap-4 px-6 text-center">
      <h1 className="text-lg font-semibold text-[#1A2E24]">ページを表示できませんでした</h1>
      <p className="text-sm text-[#47564E]">
        通信状況を確認して、もう一度お試しください。入力済みの内容は、保存済みの分がそのまま残っています。
      </p>
      <div className="flex gap-3">
        <Button type="button" variant="primary" onClick={() => reset()}>再読み込みする</Button>
        <Button asChild variant="secondary"><Link href="/projects">案件一覧へ戻る</Link></Button>
      </div>
    </main>
  )
}
