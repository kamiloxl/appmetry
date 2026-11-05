import type { ConfigContext, ExpoConfig } from 'expo/config';

// Point the demo at your appmetry server. With `wrangler dev` on this machine:
//   EXPO_PUBLIC_APPMETRY_HOST=http://localhost:8787   (iOS simulator)
//   EXPO_PUBLIC_APPMETRY_HOST=http://10.0.2.2:8787    (Android emulator)
//   EXPO_PUBLIC_APPMETRY_KEY=app_...                  (from the dashboard or POST /api/apps)
export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: 'appmetry demo',
  slug: 'appmetry-expo-demo',
  version: '1.0.0',
  orientation: 'portrait',
  icon: './assets/images/icon.png',
  scheme: 'appmetrydemo',
  userInterfaceStyle: 'automatic',
  ios: {
    supportsTablet: true,
    bundleIdentifier: 'dev.appmetry.demo',
  },
  android: {
    package: 'dev.appmetry.demo',
    adaptiveIcon: {
      backgroundColor: '#E6F4FE',
      foregroundImage: './assets/images/android-icon-foreground.png',
      backgroundImage: './assets/images/android-icon-background.png',
      monochromeImage: './assets/images/android-icon-monochrome.png',
    },
    predictiveBackGestureEnabled: false,
  },
  web: {
    bundler: 'metro',
    output: 'single',
    favicon: './assets/images/favicon.png',
  },
  plugins: [
    'expo-router',
    [
      'expo-splash-screen',
      {
        image: './assets/images/splash-icon.png',
        resizeMode: 'contain',
        backgroundColor: '#ffffff',
      },
    ],
  ],
  extra: {
    appmetryHost: process.env.EXPO_PUBLIC_APPMETRY_HOST ?? '',
    appmetryKey: process.env.EXPO_PUBLIC_APPMETRY_KEY ?? '',
  },
});
