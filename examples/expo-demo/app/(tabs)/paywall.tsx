import { Appmetry } from 'appmetry';
import { useFocusEffect } from 'expo-router';
import { useCallback } from 'react';
import { Button, StyleSheet } from 'react-native';

import { Text, View } from '@/components/Themed';

export default function PaywallScreen() {
  // Tabs stay mounted, so track on every focus rather than on mount.
  useFocusEffect(
    useCallback(() => {
      Appmetry.track('paywall_shown');
    }, []),
  );

  // No purchase SDK in the demo: a real app would call Purchases.purchasePackage() here,
  // after `Appmetry.syncRevenueCat(Purchases)` (see docs/manual-testing.md).
  const fakePurchase = async () => {
    console.log('[appmetry demo] install id:', await Appmetry.installId());
    Appmetry.track('purchase_clicked');
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Go Pro</Text>
      <View style={styles.separator} lightColor="#eee" darkColor="rgba(255,255,255,0.1)" />
      <Button title="Fake purchase" onPress={() => void fakePurchase()} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    fontSize: 20,
    fontWeight: 'bold',
  },
  separator: {
    marginVertical: 30,
    height: 1,
    width: '80%',
  },
});
