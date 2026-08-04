<script setup lang="ts">
import { NDatePicker, NSelect, NButton, NSpace } from 'naive-ui';
import dayjs from 'dayjs';

const props = defineProps<{
  range: [dayjs.Dayjs, dayjs.Dayjs];
  agent: string | null;
  provider: string | null;
  model: string | null;
  agents: string[];
  providers: string[];
  models: string[];
}>();

const emit = defineEmits<{
  (e: 'update:range', value: [dayjs.Dayjs, dayjs.Dayjs]): void;
  (e: 'update:agent', value: string | null): void;
  (e: 'update:provider', value: string | null): void;
  (e: 'update:model', value: string | null): void;
  (e: 'refresh'): void;
}>();

const agentOptions = () => [
  { label: '全部 Agent', value: '' },
  ...props.agents.map((a) => ({ label: a, value: a })),
];

const providerOptions = () => [
  { label: '全部提供商', value: '' },
  ...props.providers.map((p) => ({ label: p, value: p })),
];

const modelOptions = () => [
  { label: '全部模型', value: '' },
  ...props.models.map((m) => ({ label: m, value: m })),
];

function onRange(ts: [number, number] | null) {
  if (!ts) return;
  const [s, e] = ts;
  emit('update:range', [dayjs(s), dayjs(e)]);
}

const shortcuts: Array<{ label: string; range: () => [dayjs.Dayjs, dayjs.Dayjs] }> = [
  { label: '过去一小时', range: () => [dayjs().subtract(1, 'hour'), dayjs().endOf('day')] },
  { label: '今日', range: () => [dayjs().startOf('day'), dayjs().endOf('day')] },
  { label: '过去一周', range: () => [dayjs().subtract(7, 'day').startOf('day'), dayjs().endOf('day')] },
  { label: '过去一月', range: () => [dayjs().subtract(1, 'month').startOf('day'), dayjs().endOf('day')] },
  { label: '过去一年', range: () => [dayjs().subtract(1, 'year').startOf('day'), dayjs().endOf('day')] },
];

function pickShortcut(fn: () => [dayjs.Dayjs, dayjs.Dayjs]) {
  emit('update:range', fn());
}
</script>

<template>
  <NSpace :size="12" align="center" wrap>
    <NSelect
      :value="props.agent ?? ''"
      :options="agentOptions()"
      placeholder="Agent"
      clearable
      style="width: 140px"
      @update:value="(v: string | null) => emit('update:agent', v || null)"
    />
    <NDatePicker
      type="datetimerange"
      :value="[props.range[0].valueOf(), props.range[1].valueOf()]"
      @update:value="onRange"
      clearable
      style="width: 380px"
    />
    <NSelect
      :value="props.provider ?? ''"
      :options="providerOptions()"
      placeholder="提供商"
      clearable
      style="width: 200px"
      @update:value="(v: string | null) => emit('update:provider', v || null)"
    />
    <NSelect
      :value="props.model ?? ''"
      :options="modelOptions()"
      placeholder="模型"
      filterable
      clearable
      style="width: 260px"
      @update:value="(v: string | null) => emit('update:model', v || null)"
    />
    <NButton
      v-for="s in shortcuts"
      :key="s.label"
      size="small"
      @click="pickShortcut(s.range)"
    >
      {{ s.label }}
    </NButton>
    <NButton type="primary" @click="emit('refresh')">刷新</NButton>
  </NSpace>
</template>
