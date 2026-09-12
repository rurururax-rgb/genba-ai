-- 請求書テーブル
CREATE TABLE invoice_documents (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        UUID REFERENCES projects(id) ON DELETE CASCADE,
  company_id        UUID REFERENCES companies(id),
  invoice_number    TEXT,           -- 請-2024-001
  payment_type      TEXT DEFAULT 'custom', -- 'contract' | 'start' | 'completion' | 'custom'
  customer_name     TEXT,
  construction_name TEXT,           -- 工事名
  issued_at         DATE DEFAULT CURRENT_DATE,
  payment_due_at    DATE,
  items             JSONB NOT NULL DEFAULT '[]', -- [{id,name,quantity,unit,amount,memo}]
  adjustment        NUMERIC DEFAULT 0,           -- 調整額（端数など）
  memo              TEXT,
  status            TEXT DEFAULT 'draft',  -- 'draft' | 'issued' | 'paid'
  created_at        TIMESTAMPTZ DEFAULT now(),
  updated_at        TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE invoice_documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "自社データのみ" ON invoice_documents
  FOR ALL USING (
    company_id IN (
      SELECT company_id FROM company_members
      WHERE user_id = auth.uid()
    )
  );

CREATE INDEX idx_invoice_documents_project_id ON invoice_documents(project_id);
