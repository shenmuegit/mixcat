import { useState, type KeyboardEventHandler, type ReactNode, type RefObject } from 'react';
import { Icon } from './Icon';

type SearchFieldProps = {
  inputRef: RefObject<HTMLInputElement | null>;
  value: string;
  onChange(value: string): void;
  label: string;
  clearLabel: string;
  placeholder: string;
  className: string;
  busy?: boolean;
  controls?: string;
  onFocus?(): void;
  onKeyDown?: KeyboardEventHandler<HTMLInputElement>;
  children?: ReactNode;
};

export function SearchField({ inputRef, value, onChange, label, clearLabel, placeholder, className, busy, controls, onFocus, onKeyDown, children }: SearchFieldProps) {
  const [composition, setComposition] = useState<string | null>(null);
  const text = composition ?? value;
  return <div className={`search-field ${className}`} role="search" aria-label={label} aria-busy={busy || undefined}>
    {busy ? <span className="search-field-spinner" aria-hidden="true" /> : <Icon name="search" size={16} />}
    <input ref={inputRef} type="search" aria-label={label} aria-controls={controls} value={text} placeholder={placeholder} onFocus={onFocus}
      onCompositionStart={event => setComposition(event.currentTarget.value)}
      onCompositionEnd={event => { setComposition(null); onChange(event.currentTarget.value); }}
      onChange={event => {
        if (composition === null) onChange(event.currentTarget.value);
        else setComposition(event.currentTarget.value);
      }}
      onKeyDown={event => {
        if (composition === null && !event.nativeEvent.isComposing) onKeyDown?.(event);
      }} />
    {text && <button type="button" className="search-field-clear" aria-label={clearLabel} title={clearLabel} onClick={() => {
      setComposition(null);
      onChange('');
      inputRef.current?.focus({ preventScroll: true });
    }}><Icon name="close" size={14} /></button>}
    {children}
  </div>;
}
