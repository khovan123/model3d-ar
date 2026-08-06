import Link from "next/link";

export default function HomePage() {
  return (
    <main className="landing-shell">
      <nav className="topbar">
        <Link href="/" className="brand">MODEL<span>SPACE</span></Link>
        <Link href="/studio" className="button button-ghost">Studio</Link>
      </nav>

      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow">3D PRESENTATION PLATFORM</p>
          <h1>Đưa thiết kế 3D<br />đến mọi màn hình.</h1>
          <p className="lead">
            Designer tải model lên, hệ thống tạo QR riêng. Người xem chỉ cần quét mã để khám phá model bằng cảm biến chuyển động hoặc thao tác tay.
          </p>
          <div className="hero-actions">
            <Link href="/studio" className="button button-primary">Tải model lên</Link>
            <a href="#workflow" className="text-link">Xem cách hoạt động →</a>
          </div>
        </div>

        <div className="hero-visual" aria-hidden="true">
          <div className="orb orb-back" />
          <div className="wire-cube">
            <div className="cube-face cube-front" />
            <div className="cube-face cube-back" />
            <span className="cube-line line-1" />
            <span className="cube-line line-2" />
            <span className="cube-line line-3" />
            <span className="cube-line line-4" />
          </div>
          <div className="visual-badge">THREE.JS<br /><strong>REALTIME</strong></div>
        </div>
      </section>

      <section className="workflow" id="workflow">
        <article><span>01</span><h2>Upload GLB</h2><p>Một file duy nhất chứa geometry, material và texture.</p></article>
        <article><span>02</span><h2>Nhận QR</h2><p>Mỗi model có đường dẫn công khai và QR có thể tải xuống.</p></article>
        <article><span>03</span><h2>Tương tác</h2><p>Chuyển đổi giữa điều khiển cảm biến và xoay bằng tay.</p></article>
      </section>
    </main>
  );
}
