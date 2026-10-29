import { createRoot } from 'react-dom/client';
import '@xyflow/react/dist/style.css';
import './styles.css';
import './ProjectManagement.css';
import './SharedDocument.css';
import './Notes.css';
import './feed.css';
import App from './App';

const root = document.getElementById('root');
if (!root) throw new Error('Mixcat root element is missing.');
createRoot(root).render(<App />);
