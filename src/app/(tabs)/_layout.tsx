import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { Tabs } from 'expo-router/js-tabs';
import type { ComponentProps } from 'react';
import { Pressable } from 'react-native';
import { colors } from '../../theme';

type IconName = ComponentProps<typeof Ionicons>['name'];

function icon(name: IconName) {
  return function TabIcon({ color, size }: { color: unknown; size: number }) {
    return <Ionicons name={name} size={size} color={color as string} />;
  };
}

const SettingsButton = () => (
  <Pressable
    onPress={() => router.push('/settings')}
    hitSlop={10}
    style={{ paddingHorizontal: 16 }}
    accessibilityLabel="Settings"
  >
    <Ionicons name="settings-outline" size={22} color={colors.text} />
  </Pressable>
);

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: colors.bg },
        headerTintColor: colors.text,
        headerRight: SettingsButton,
        tabBarStyle: { backgroundColor: colors.bg, borderTopColor: colors.border },
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.muted,
      }}
    >
      <Tabs.Screen name="index" options={{ title: 'Dashboard', tabBarIcon: icon('speedometer-outline') }} />
      <Tabs.Screen name="screener" options={{ title: 'Screener', tabBarIcon: icon('pulse-outline') }} />
      <Tabs.Screen name="trend" options={{ title: 'Trend', tabBarIcon: icon('trending-up') }} />
      <Tabs.Screen name="options" options={{ title: 'Option Chain', tabBarIcon: icon('grid-outline') }} />
      <Tabs.Screen name="memory" options={{ title: 'Memory', tabBarIcon: icon('analytics-outline') }} />
      <Tabs.Screen name="journal" options={{ title: 'Journal', tabBarIcon: icon('book-outline') }} />
      <Tabs.Screen name="markets" options={{ title: 'Markets', tabBarIcon: icon('stats-chart-outline') }} />
      <Tabs.Screen name="portfolio" options={{ title: 'Portfolio', tabBarIcon: icon('briefcase-outline') }} />
    </Tabs>
  );
}
