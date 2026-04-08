import React from 'react';
import ReactDOM from 'react-dom/client';
import { ConfigProvider } from 'antd';
import taranisTheme from './theme/taranisTheme.js';
import App from './App.jsx';
import './theme/globals.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ConfigProvider theme={taranisTheme}>
      <App />
    </ConfigProvider>
  </React.StrictMode>,
);
