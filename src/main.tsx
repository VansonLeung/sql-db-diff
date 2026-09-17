import './bridge';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { ConfigProvider, App as AntApp } from 'antd';
import App from './App';
import './styles.css';
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConfigProvider
      theme={{
        token: {
          colorPrimary: '#5367e8',
          colorText: '#20283f',
          colorBorder: '#e2e6ef',
          borderRadius: 8,
          fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
          fontSize: 13,
        },
        components: { Table: { headerBg: '#f8f9fc' }, Tabs: { horizontalItemGutter: 28 } },
      }}
    >
      <AntApp>
        <App />
      </AntApp>
    </ConfigProvider>
  </React.StrictMode>,
);

if (import.meta.env.MODE === 'smoke' && window.dbDiff)
  void import('./smoke').then(({ runSmoke }) => runSmoke());
