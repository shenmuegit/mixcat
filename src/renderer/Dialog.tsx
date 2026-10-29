import { useEffect, useRef, type ReactNode, type RefObject } from 'react';

export function Dialog({ title, children, onClose, wide = false, initialFocus, descriptionId }: {
  title: string; children: ReactNode; onClose: () => void; wide?: boolean;
  initialFocus?: RefObject<HTMLElement | null>; descriptionId?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal(); initialFocus?.current?.focus({ preventScroll: true });
    return () => dialog?.close();
  }, [initialFocus]);
  return <dialog className={`modal ${wide ? 'wide-modal' : ''}`} ref={ref} onCancel={event => { event.preventDefault(); onClose(); }} aria-label={title} aria-describedby={descriptionId}><div className="modal-heading"><h2>{title}</h2><button type="button" className="icon-button" aria-label="关闭弹窗" onClick={onClose}>×</button></div>{children}</dialog>;
}
