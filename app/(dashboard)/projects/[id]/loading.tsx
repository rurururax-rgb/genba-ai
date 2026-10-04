/**
 * 案件画面を開くまでの表示。サーバーでの取得に数秒かかるため、
 * 押したことが伝わらず二度押しされないよう、すぐに「案件を開いています」を出す。
 */
export default function ProjectLoading() {
  return (
    <div style={{ background: '#F3F7F4', minHeight: '100vh' }}>
      <div
        role="status"
        aria-live="polite"
        style={{
          background: '#FFFFFF', borderBottom: '1px solid #E8ECF6',
          padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 8,
          fontSize: 13, fontWeight: 600, color: '#3D7A55',
        }}
      >
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#6CB382' }} />
        案件を開いています…
      </div>
    </div>
  )
}
