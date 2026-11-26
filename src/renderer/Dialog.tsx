import { useEffect, useRef, type ReactNode, type RefObject } from 'react';
import { Icon } from './Icon';

export function Dialog({ title, children, onClose, wide = false, initialFocus, descriptionId, closeLabel = '关闭弹窗', closeDisabled = false, className }: {
  title: string; children: ReactNode; onClose: () => void; wide?: boolean;
  initialFocus?: RefObject<HTMLElement | null>; descriptionId?: string; closeLabel?: string; closeDisabled?: boolean; className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal(); initialFocus?.current?.focus({ preventScroll: true });
    return () => dialog?.close();
  }, [initialFocus]);
  return <dialog className={['modal', wide && 'wide-modal', className].filter(Boolean).join(' ')} ref={ref}
    onCancel={event => { event.preventDefault(); if (!closeDisabled) onClose(); }} aria-label={title} aria-describedby={descriptionId}>
    <div className="modal-heading"><h2>{title}</h2><button type="button" className="icon-button dialog-close" aria-label={closeLabel}
      title={closeLabel} disabled={closeDisabled} onClick={onClose}><Icon name="close" size={16} /></button></div>
    {children}
  </dialog>;
}
