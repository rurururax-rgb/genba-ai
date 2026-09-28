import { notFound } from 'next/navigation'
import { EstimateFixture } from '@/components/qa/EstimateFixture'

// 開発環境専用：本番DBに触れずに EstimateTab を Browser QA するための Fixture ページ
export default function EstimateFixturePage() {
  if (process.env.NODE_ENV === 'production') notFound()
  return <EstimateFixture />
}
