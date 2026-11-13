import { h, render } from 'preact';
import { App } from './app/App';
import './app/theme.css';

const root = document.getElementById('app');
if (root) render(h(App, null), root);
