import { useEffect } from 'react';

/** 图片放大预览：支持多图左右切换、Esc 关闭、点击遮罩关闭 */
export function ImageLightbox({
  images,
  index,
  onClose,
  onNavigate,
}: {
  images: string[];
  index: number;
  onClose: () => void;
  onNavigate: (index: number) => void;
}) {
  const total = images.length;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (total > 1 && e.key === 'ArrowLeft') {
        onNavigate((index - 1 + total) % total);
      }
      if (total > 1 && e.key === 'ArrowRight') {
        onNavigate((index + 1) % total);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index, total, onClose, onNavigate]);

  return (
    <div className="image-lightbox" onClick={onClose}>
      <button
        type="button"
        className="lightbox-close"
        onClick={onClose}
        aria-label="关闭"
        title="关闭 (Esc)"
      >
        <svg
          viewBox="0 0 16 16"
          width="16"
          height="16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          aria-hidden
        >
          <path d="m4 4 8 8m0-8-8 8" />
        </svg>
      </button>
      {total > 1 ? (
        <button
          type="button"
          className="lightbox-nav lightbox-prev"
          onClick={(e) => {
            e.stopPropagation();
            onNavigate((index - 1 + total) % total);
          }}
          aria-label="上一张"
        >
          ‹
        </button>
      ) : null}
      <img
        src={images[index]}
        alt={`图片预览 ${index + 1}`}
        className="lightbox-img"
        onClick={(e) => e.stopPropagation()}
      />
      {total > 1 ? (
        <button
          type="button"
          className="lightbox-nav lightbox-next"
          onClick={(e) => {
            e.stopPropagation();
            onNavigate((index + 1) % total);
          }}
          aria-label="下一张"
        >
          ›
        </button>
      ) : null}
      {total > 1 ? (
        <div className="lightbox-counter">
          {index + 1} / {total}
        </div>
      ) : null}
    </div>
  );
}
