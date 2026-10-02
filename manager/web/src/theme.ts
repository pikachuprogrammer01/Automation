import { theme as antdTheme } from 'antd';
import type { ThemeConfig } from 'antd';

/** 沿用旧版深色配色，避免换前端框架时视觉突变。 */
export const managerTheme: ThemeConfig = {
  algorithm: antdTheme.darkAlgorithm,
  token: {
    colorPrimary: '#7ca7ff',
    colorInfo: '#7ca7ff',
    colorBgBase: '#0c0f14',
    colorBgContainer: '#141922',
    colorBgElevated: '#1a202b',
    colorBorder: '#2a3443',
    colorBorderSecondary: '#232c39',
    colorText: '#eef2f7',
    colorTextSecondary: '#97a2b2',
    borderRadius: 12,
    fontSize: 14,
  },
  components: {
    Card: { colorBgContainer: '#141922', colorBorderSecondary: '#2a3443' },
    Layout: { headerBg: 'transparent', bodyBg: 'transparent' },
  },
};
