import { Appmetry, AppmetryProvider } from 'appmetry';
import Constants from 'expo-constants';
import { useFonts } from 'expo-font';
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect } from 'react';
import 'react-native-reanimated';

import { useColorScheme } from '@/components/useColorScheme';

export {
  // Catch any errors thrown by the Layout component.
  ErrorBoundary,
} from 'expo-router';

// Host and key come from app.config.ts `extra` (EXPO_PUBLIC_APPMETRY_HOST / EXPO_PUBLIC_APPMETRY_KEY).
const extra = (Constants.expoConfig?.extra ?? {}) as { appmetryHost?: string; appmetryKey?: string };

// Initialize once, at module load, before any screen renders.
if (extra.appmetryHost && extra.appmetryKey) {
  Appmetry.init({ appKey: extra.appmetryKey, host: extra.appmetryHost, debug: __DEV__ });
} else {
  console.warn('[appmetry demo] Set EXPO_PUBLIC_APPMETRY_HOST and EXPO_PUBLIC_APPMETRY_KEY to send events.');
}

// Prevent the splash screen from auto-hiding before asset loading is complete.
SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const [loaded, error] = useFonts({
    SpaceMono: require('../assets/fonts/SpaceMono-Regular.ttf'),
  });

  // Expo Router uses Error Boundaries to catch errors in the navigation tree.
  useEffect(() => {
    if (error) throw error;
  }, [error]);

  useEffect(() => {
    if (loaded) {
      SplashScreen.hideAsync();
    }
  }, [loaded]);

  if (!loaded) {
    return null;
  }

  return <RootLayoutNav />;
}

function RootLayoutNav() {
  const colorScheme = useColorScheme();

  return (
    <AppmetryProvider>
      <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
        <Stack>
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        </Stack>
      </ThemeProvider>
    </AppmetryProvider>
  );
}
