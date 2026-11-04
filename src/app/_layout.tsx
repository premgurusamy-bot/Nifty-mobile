import { DarkTheme, Stack, ThemeProvider } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { AlertsProvider } from '../state/AlertsContext';
import { EngineProvider } from '../state/EngineContext';
import { MarketProvider } from '../state/MarketContext';
import { SettingsProvider } from '../state/SettingsContext';
import { PortfolioProvider } from '../state/PortfolioContext';
import { colors } from '../theme';

const theme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: colors.bg,
    card: colors.bg,
    border: colors.border,
    primary: colors.accent,
    text: colors.text,
  },
};

export default function RootLayout() {
  return (
    <ThemeProvider value={theme}>
      <SettingsProvider>
        <EngineProvider>
          <AlertsProvider>
          <MarketProvider>
            <PortfolioProvider>
              <StatusBar style="light" />
              <Stack
                screenOptions={{
                  headerStyle: { backgroundColor: colors.bg },
                  headerTintColor: colors.text,
                  contentStyle: { backgroundColor: colors.bg },
                }}
              >
                <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
                <Stack.Screen name="instrument/[id]" options={{ title: '' }} />
                <Stack.Screen name="order" options={{ presentation: 'modal', title: 'Place order' }} />
                <Stack.Screen name="settings" options={{ title: 'Settings' }} />
                <Stack.Screen name="orders" options={{ title: 'Orders' }} />
              </Stack>
            </PortfolioProvider>
          </MarketProvider>
          </AlertsProvider>
        </EngineProvider>
      </SettingsProvider>
    </ThemeProvider>
  );
}
