import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { cachedArtwork, loadArtwork } from "../lib/artwork";
import { localize, useLanguage } from "../i18n";
interface Props {
  src: string;
  alt: string;
  className?: string;
  loading?: "eager" | "lazy";
}
export default function CachedArt({ src, alt, className, loading = "eager" }: Props) {
  useLanguage();
  const [resolved, setResolved] = useState(() => cachedArtwork(src)),
    [failed, setFailed] = useState(false),
    [visible, setVisible] = useState(loading !== "lazy");
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    setResolved(cachedArtwork(src));
    setFailed(false);
  }, [src]);
  useEffect(() => {
    if (loading !== "lazy" || resolved) {
      setVisible(true);
      return;
    }
    const node = ref.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "350px" }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [src, loading, resolved]);
  useEffect(() => {
    if (!visible) return;
    let disposed = false;
    void loadArtwork(src)
      .then((value) => {
        if (!disposed) setResolved(value);
      })
      .catch(() => {
        if (!disposed) setFailed(true);
      });
    return () => {
      disposed = true;
    };
  }, [src, visible]);
  return (
    <span ref={ref} className={`relative block overflow-hidden ${className ?? ""}`}>
      {!resolved && !failed && (
        <span className="animate-shimmer from-charcoal-600 via-charcoal-400 to-charcoal-600 absolute inset-0 bg-linear-to-r bg-size-[200%_100%]" />
      )}
      {resolved && !failed && (
        <img
          src={resolved}
          alt={localize(alt)}
          className="h-full w-full object-cover object-[center_20%]"
          decoding="async"
          draggable={false}
          onError={() => setFailed(true)}
        />
      )}
      {failed && (
        <span className="bg-charcoal-600 text-ink-muted absolute inset-0 flex items-center justify-center text-[10px]">
          {localize("No preview")}
        </span>
      )}
    </span>
  );
}
