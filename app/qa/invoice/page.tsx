import { notFound } from 'next/navigation'
import { InvoiceFixture } from '@/components/qa/InvoiceFixture'

// 開発環境専用：本番DBに触れずに InvoiceTab を Browser QA するための Fixture ページ
export default function InvoiceFixturePage() {
  if (process.env.NODE_ENV === 'production') notFound()
  return <InvoiceFixture />
}
