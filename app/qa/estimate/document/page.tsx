import { notFound } from 'next/navigation'
import { EstimateDocumentFixture } from '@/components/qa/EstimateDocumentFixture'

// 開発環境専用：Fixture データでお客様向け見積書（プレビュー / 印刷）を表示する
export default function EstimateDocumentFixturePage() {
  if (process.env.NODE_ENV === 'production') notFound()
  return <EstimateDocumentFixture />
}
