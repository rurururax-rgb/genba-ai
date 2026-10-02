import { notFound } from 'next/navigation'
import { CostLedgerFixture } from '@/components/qa/CostLedgerFixture'

// 開発環境専用：本番DBに触れずに CostLedgerTab を Browser QA するための Fixture ページ
export default function CostLedgerFixturePage() {
  if (process.env.NODE_ENV === 'production') notFound()
  return <CostLedgerFixture />
}
