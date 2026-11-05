import { Appdash } from '@appdash/expo';
import { useEffect, useState } from 'react';
import { Button, StyleSheet } from 'react-native';

import { Text, View } from '@/components/Themed';

export default function HomeScreen() {
  const [iid, setIid] = useState<string | null>(null);

  useEffect(() => {
    void Appdash.installId().then(setIid);
  }, []);

  return (
    <View style={styles.container}>
      <Text style={styles.title}>appdash demo</Text>
      <View style={styles.separator} lightColor="#eee" darkColor="rgba(255,255,255,0.1)" />
      <Text style={styles.mono}>install id: {iid ?? '(not yet)'}</Text>
      <View style={styles.buttons}>
        <Button title="Track button_tapped" onPress={() => Appdash.track('button_tapped', { screen: 'home' })} />
        <Button title="Flush now" onPress={() => void Appdash.flush()} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
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
  mono: {
    fontFamily: 'SpaceMono',
    fontSize: 12,
  },
  buttons: {
    marginTop: 20,
    gap: 8,
  },
});
