import React from 'react';
import { createRoot } from 'react-dom/client';
import { createDigHost } from './shared/host';
import { CardApp } from './card/App';
import './shared/styles.css';
import './card/styles.css';

export { CardApp } from './card/App';

const root = document.getElementById('root');
if (root) createRoot(root).render(<CardApp host={createDigHost('Dig saved research')} />);
