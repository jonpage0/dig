import React from 'react';
import { createRoot } from 'react-dom/client';
import { createDigHost } from './shared/host';
import { LibraryApp } from './library/app';
import './shared/styles.css';
import './shared/legacy-library.css';

export { LibraryApp } from './library/app';

export function mountLibraryApp(host = createDigHost('Dig Library'), element = document.getElementById('root')!) {
  const root = createRoot(element);
  root.render(<LibraryApp host={host} />);
  return () => root.unmount();
}

if (document.getElementById('root')) mountLibraryApp();
