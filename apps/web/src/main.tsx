import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AuthGate } from './AuthGate.tsx';
import '@fontsource-variable/inter/index.css';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root element missing');

createRoot(root).render(
  <StrictMode>
    <AuthGate />
  </StrictMode>,
);
