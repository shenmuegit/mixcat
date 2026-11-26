export function KeyboardHint({ keys, label }: { keys: readonly string[]; label: string }) {
  return <span className="keyboard-hint" aria-hidden="true">
    <span className="keyboard-keys">{keys.map(key => <kbd key={key}>{key}</kbd>)}</span>
    <span>{label}</span>
  </span>;
}

export function ComposerKeyboardHints() {
  return <span className="composer-keyboard-hints">
    <KeyboardHint keys={['Enter']} label="发送" />
    <KeyboardHint keys={['Ctrl', 'Enter']} label="换行" />
  </span>;
}
