import { App as AntApp, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import 'antd/dist/reset.css';
import { createRoot } from 'react-dom/client';
import Manager from './App';
import './index.css';
import { managerTheme } from './theme';

createRoot(document.getElementById('root')!).render(
  <ConfigProvider locale={zhCN} theme={managerTheme}>
    <AntApp>
      <Manager />
    </AntApp>
  </ConfigProvider>,
);
