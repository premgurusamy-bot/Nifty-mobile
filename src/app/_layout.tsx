import { DarkTheme, Stack, ThemeProvider } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { MarketProvider } from '../state/MarketContext';
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
          </Stack>
        </PortfolioProvider>
      </MarketProvider>
    </ThemeProvider>
  );
}
