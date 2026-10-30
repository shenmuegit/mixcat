import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { ComfyProviderSettings } from '../../src/renderer/ComfyProviderSettings.js';
import '../../src/renderer/styles.css';

function Proof() {
  const [open, setOpen] = useState(true);
  return <>{open ? <ComfyProviderSettings projectId="native-credentials" onClose={() => setOpen(false)} /> : <button onClick={() => setOpen(true)}>打开连接设置</button>}</>;
}
createRoot(document.getElementById('root')!).render(<Proof />);
