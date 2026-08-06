import Link from "next/link";

export default function NotFound() {
  return (
    <main className="center-page">
      <p className="eyebrow">404</p>
      <h1>Không tìm thấy model</h1>
      <p>Model có thể đã bị xóa hoặc đường dẫn không chính xác.</p>
      <Link className="button button-primary" href="/">Về trang chủ</Link>
    </main>
  );
}
