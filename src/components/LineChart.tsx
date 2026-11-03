import { useState } from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import Svg, { Defs, LinearGradient, Path, Stop } from 'react-native-svg';
import { colors } from '../theme';

interface Props {
  data: number[];
  height?: number;
  /** Baseline used to decide colour (e.g. previous close). Defaults to first point. */
  baseline?: number;
  showFill?: boolean;
}

export function LineChart({ data, height = 160, baseline, showFill = true }: Props) {
  const [width, setWidth] = useState(0);
  const onLayout = (e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width);

  let line = '';
  let area = '';
  if (width > 0 && data.length > 1) {
    const min = Math.min(...data);
    const max = Math.max(...data);
    const span = max - min || 1;
    const pad = 4;
    const pts = data.map((v, i) => [
      (i / (data.length - 1)) * width,
      pad + (1 - (v - min) / span) * (height - pad * 2),
    ]);
    line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
    area = `${line} L${width},${height} L0,${height} Z`;
  }

  const ref = baseline ?? data[0];
  const color = data[data.length - 1] >= ref ? colors.up : colors.down;
  const gid = color === colors.up ? 'gUp' : 'gDown';

  return (
    <View style={{ height }} onLayout={onLayout}>
      {width > 0 && (
        <Svg width={width} height={height}>
          <Defs>
            <LinearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor={color} stopOpacity={0.3} />
              <Stop offset="1" stopColor={color} stopOpacity={0} />
            </LinearGradient>
          </Defs>
          {showFill && <Path d={area} fill={`url(#${gid})`} />}
          <Path d={line} stroke={color} strokeWidth={1.75} fill="none" />
        </Svg>
      )}
    </View>
  );
}
