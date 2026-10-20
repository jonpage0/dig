import React from 'react';
import { createRoot } from 'react-dom/client';
import { createDigHost } from './shared/host';
import { LibraryApp } from './library/app';
import './shared/styles.css';
import './shared/legacy-library.css';
import './library/source-controls.css';
import './library/sources.css';
import './library/guide.css';
import './library/settings.css';
import './library/about.css';
import './library/research-overview.css';
import './library/research-detail.css';
import './library/polish.css';

export { LibraryApp } from './library/app';

export function mountLibraryApp(host = createDigHost('Dig Library'), element = document.getElementById('root')!) {
  const root = createRoot(element);
  root.render(<LibraryApp host={host} />);
  return () => root.unmount();
}

if (document.getElementById('root')) mountLibraryApp();
