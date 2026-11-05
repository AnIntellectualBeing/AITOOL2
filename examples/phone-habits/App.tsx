import { useRef, useState } from 'react';
import { Animated, Easing, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';

// Design tokens measured by Remake (palette / typeScale / spacing)
const C = {
  bg: '#fbf8f3',
  surface: '#ffffff',
  text: '#1f2a24',
  muted: '#75807a',
  accent: '#2f8f5b',
  line: '#ece7de',
};
const SAFE_TOP = 60; // the recording had a status bar; keep the safe-area padding, not the bar
const PAD = 22;

const HABITS = [
  { name: 'Read 20 pages', sub: '12 day streak', color: '#2f8f5b', done: true, letter: 'R' },
  { name: 'Morning run', sub: '3 day streak', color: '#e0a526', done: true, letter: 'M' },
  { name: 'Meditate', sub: 'Not yet today', color: '#3b82f6', done: false, letter: 'Z' },
  { name: 'No phone after 10', sub: 'Not yet today', color: '#e2557a', done: false, letter: 'N' },
];

export default function App() {
  const { width, height } = useWindowDimensions();
  const push = useRef(new Animated.Value(0)).current; // 0 = Today, 1 = detail
  const sheet = useRef(new Animated.Value(0)).current; // 0 = closed, 1 = open
  const [detailOpen, setDetailOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);

  // Measured: push 320–333 ms ease-in-out; sheet ~333–360 ms ease-out with a fading scrim.
  const openDetail = () => {
    setDetailOpen(true);
    Animated.timing(push, { toValue: 1, duration: 320, easing: Easing.bezier(0.42, 0, 0.58, 1), useNativeDriver: false }).start();
  };
  const closeDetail = () =>
    Animated.timing(push, { toValue: 0, duration: 320, easing: Easing.bezier(0.42, 0, 0.58, 1), useNativeDriver: false }).start(() => setDetailOpen(false));
  const openSheet = () => {
    setSheetOpen(true);
    Animated.timing(sheet, { toValue: 1, duration: 360, easing: Easing.bezier(0, 0, 0.58, 1), useNativeDriver: false }).start();
  };
  const closeSheet = () =>
    Animated.timing(sheet, { toValue: 0, duration: 360, easing: Easing.bezier(0, 0, 0.58, 1), useNativeDriver: false }).start(() => setSheetOpen(false));

  return (
    <View style={[styles.root, { width, height }]}>
      {/* Today */}
      <View style={styles.screen}>
        <Text style={styles.date}>Thursday, June 12</Text>
        <Text style={styles.h1}>Good morning</Text>
        <View style={styles.summary}>
          <View>
            <Text style={styles.summaryBig}>2 of 4</Text>
            <Text style={styles.summarySmall}>habits done today</Text>
          </View>
          <View style={styles.ring} />
        </View>
        <View style={{ gap: 12 }}>
          {HABITS.map((h) => (
            <Pressable key={h.name} onPress={openDetail} style={styles.habit} accessibilityRole="button" testID={`habit-${h.letter}`}>
              <View style={[styles.dot, { backgroundColor: h.color }]}>
                <Text style={styles.dotText}>{h.letter}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.habitName}>{h.name}</Text>
                <Text style={styles.habitSub}>{h.sub}</Text>
              </View>
              <View style={[styles.tick, h.done && styles.tickOn]} />
            </Pressable>
          ))}
        </View>
        <Pressable style={styles.fab} onPress={openSheet} accessibilityLabel="New habit" testID="fab">
          <Text style={styles.fabText}>+</Text>
        </Pressable>
        <View style={styles.tabbar}>
          {['Today', 'Stats', 'Profile'].map((t, i) => (
            <View key={t} style={styles.tab}>
              <View style={[styles.tabIcon, i === 0 && { backgroundColor: C.accent }]} />
              <Text style={[styles.tabText, i === 0 && { color: C.accent }]}>{t}</Text>
            </View>
          ))}
        </View>
      </View>

      {/* Habit detail (pushed from the right) */}
      {detailOpen && (
        <Animated.View style={[styles.screen, { transform: [{ translateX: push.interpolate({ inputRange: [0, 1], outputRange: [width, 0] }) }] }]}>
          <Pressable onPress={closeDetail} accessibilityLabel="Back to Today" testID="back">
            <Text style={styles.back}>‹ Today</Text>
          </Pressable>
          <Text style={[styles.label, { marginTop: 18 }]}>CURRENT STREAK</Text>
          <Text style={styles.big}>12 days</Text>
          <View style={styles.week}>
            {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => (
              <View key={i} style={{ flex: 1, alignItems: 'center' }}>
                <View style={[styles.day, i < 4 && { backgroundColor: C.accent }]} />
                <Text style={styles.dayText}>{d}</Text>
              </View>
            ))}
          </View>
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Read 20 pages</Text>
            <Text style={styles.habitSub}>Every day · 8:00 PM reminder</Text>
          </View>
          <Pressable style={styles.primary} testID="mark-done">
            <Text style={styles.primaryText}>Mark as done</Text>
          </Pressable>
        </Animated.View>
      )}

      {/* New habit sheet */}
      {sheetOpen && (
        <>
          <Animated.View style={[StyleSheet.absoluteFill, styles.scrim, { opacity: sheet }]}>
            <Pressable style={StyleSheet.absoluteFill} onPress={closeSheet} />
          </Animated.View>
          <Animated.View style={[styles.sheet, { transform: [{ translateY: sheet.interpolate({ inputRange: [0, 1], outputRange: [height * 0.45, 0] }) }] }]}>
            <View style={styles.grab} />
            <Text style={styles.h2}>New habit</Text>
            <View style={styles.field}>
              <Text style={styles.fieldText}>e.g. Drink water</Text>
            </View>
            <Text style={styles.label}>COLOUR</Text>
            <View style={styles.chips}>
              {['#2f8f5b', '#e0a526', '#3b82f6', '#e2557a'].map((c) => (
                <View key={c} style={[styles.chip, { backgroundColor: c }]} />
              ))}
            </View>
            <Pressable style={styles.primary} onPress={closeSheet} testID="create">
              <Text style={styles.primaryText}>Create habit</Text>
            </Pressable>
          </Animated.View>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { backgroundColor: C.bg, overflow: 'hidden' },
  screen: { ...StyleSheet.absoluteFillObject, backgroundColor: C.bg, paddingTop: SAFE_TOP, paddingHorizontal: PAD },
  date: { color: C.muted, fontSize: 15, lineHeight: 21 },
  h1: { fontSize: 30, lineHeight: 42, fontWeight: '700', color: C.text, letterSpacing: -0.6, marginTop: 4, marginBottom: 2 },
  summary: { marginTop: 20, marginBottom: 18, backgroundColor: C.accent, borderRadius: 18, paddingVertical: 18, paddingHorizontal: 20, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  summaryBig: { color: '#fff', fontSize: 28, lineHeight: 39, fontWeight: '700' },
  summarySmall: { color: '#fff', fontSize: 16, lineHeight: 22 },
  ring: { width: 54, height: 54, borderRadius: 27, borderWidth: 6, borderColor: 'rgba(255,255,255,0.35)', borderTopColor: '#fff', borderRightColor: '#fff' },
  habit: { backgroundColor: C.surface, borderRadius: 18, paddingVertical: 16, paddingHorizontal: 18, flexDirection: 'row', alignItems: 'center', gap: 14, borderWidth: 1, borderColor: C.line },
  dot: { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  dotText: { color: '#fff', fontSize: 18, fontWeight: '700' },
  habitName: { fontSize: 17, lineHeight: 24, fontWeight: '700', color: C.text },
  habitSub: { fontSize: 14, lineHeight: 22, color: C.muted },
  tick: { width: 28, height: 28, borderRadius: 14, borderWidth: 2, borderColor: C.line },
  tickOn: { backgroundColor: C.accent, borderColor: C.accent },
  fab: { position: 'absolute', right: PAD, bottom: 104, width: 60, height: 60, borderRadius: 30, backgroundColor: C.text, alignItems: 'center', justifyContent: 'center', shadowColor: '#000', shadowOpacity: 0.18, shadowRadius: 20, shadowOffset: { width: 0, height: 8 } },
  fabText: { color: '#fff', fontSize: 32, lineHeight: 36 },
  tabbar: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 84, backgroundColor: C.surface, borderTopWidth: 1, borderTopColor: C.line, flexDirection: 'row', justifyContent: 'space-around', paddingTop: 12 },
  tab: { alignItems: 'center', gap: 4 },
  tabIcon: { width: 24, height: 24, borderRadius: 7, backgroundColor: C.line },
  tabText: { fontSize: 12, lineHeight: 17, color: C.muted },
  back: { fontSize: 17, lineHeight: 20, color: C.accent, fontWeight: '600', paddingVertical: 6 },
  label: { fontSize: 13, lineHeight: 18.2, letterSpacing: 0.8, color: C.muted, fontWeight: '600', marginBottom: 10 },
  big: { fontSize: 76, fontWeight: '800', letterSpacing: -3, color: C.text, marginTop: 12, lineHeight: 76 }, // CSS margins collapsed (22 - 10)
  week: { flexDirection: 'row', gap: 8, marginVertical: 26 },
  day: { height: 38, alignSelf: 'stretch', borderRadius: 12, backgroundColor: C.line, marginBottom: 6 },
  dayText: { fontSize: 13, lineHeight: 18, color: C.muted },
  card: { backgroundColor: C.surface, borderRadius: 18, borderWidth: 1, borderColor: C.line, paddingVertical: 16, paddingHorizontal: 18, marginBottom: 18 },
  cardTitle: { fontSize: 16, lineHeight: 22, fontWeight: '700', color: C.text },
  primary: { backgroundColor: C.accent, borderRadius: 16, paddingVertical: 17, alignItems: 'center' },
  primaryText: { color: '#fff', fontSize: 17, lineHeight: 20, fontWeight: '700' },
  scrim: { backgroundColor: 'rgba(15,20,18,0.4)' },
  sheet: { position: 'absolute', left: 0, right: 0, bottom: 0, backgroundColor: C.surface, borderTopLeftRadius: 26, borderTopRightRadius: 26, paddingTop: 14, paddingHorizontal: PAD, paddingBottom: 40 },
  grab: { width: 40, height: 5, borderRadius: 3, backgroundColor: C.line, alignSelf: 'center', marginBottom: 18 },
  h2: { fontSize: 22, lineHeight: 31, fontWeight: '700', color: C.text, marginBottom: 16 },
  field: { borderWidth: 1.5, borderColor: C.line, borderRadius: 14, paddingVertical: 15, paddingHorizontal: 16, marginBottom: 18 },
  fieldText: { fontSize: 17, lineHeight: 24, color: C.muted },
  chips: { flexDirection: 'row', gap: 10, marginBottom: 24 },
  chip: { width: 38, height: 38, borderRadius: 19 },
});
