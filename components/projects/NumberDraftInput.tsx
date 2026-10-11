'use client'

import { useState } from 'react'
import { Input, type InputProps } from '@/components/ui/input'
import { normalizeNumberDraft, numberDraftValue, syncNumberDraft } from '@/lib/input/numeric-input'

type Props = Omit<InputProps, 'type' | 'value' | 'defaultValue' | 'onChange'> & {
  value: number
  onValueChange: (value: number) => void
}

/**
 * 数値の <input type="number">。入力中の文字列（draft）と確定値（value）を分けて持つ。
 *
 * - 先頭の 0 は入力中に取り除く（0 に続けて 1000 と打つ・001000 を貼り付ける → 1000）
 * - 入力途中は空欄にできる（その間の値は 0）。フォーカスを外すと確定値を表示する
 * - 外から value が変わったとき（自動入力・保存後）は表示を合わせる
 */
export function NumberDraftInput({ value, onValueChange, onBlur, ...props }: Props) {
  const [draft, setDraft] = useState(() => String(value))
  const [shown, setShown] = useState(value)
  if (value !== shown) {
    setShown(value)
    setDraft(syncNumberDraft(draft, value))
  }

  return (
    <Input
      {...props}
      type="number"
      value={draft}
      onChange={e => {
        const next = normalizeNumberDraft(e.target.value)
        const n = numberDraftValue(next)
        setDraft(next)
        setShown(n)
        if (n !== value) onValueChange(n)
      }}
      onBlur={e => {
        setDraft(String(value))
        onBlur?.(e)
      }}
    />
  )
}
