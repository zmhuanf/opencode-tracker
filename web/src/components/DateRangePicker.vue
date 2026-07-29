<script setup lang="ts">
import { NDatePicker, NSelect, NButton, NSpace } from 'naive-ui';
import dayjs from 'dayjs';

const props = defineProps<{
  range: [dayjs.Dayjs, dayjs.Dayjs];
  provider: string | null;
  model: string | null;
  providers: string[];
  models: string[];
}>();

const emit = defineEmits<{
  (e: 'update:range', value: [dayjs.Dayjs, dayjs.Dayjs]): void;
  (e: 'update:provider', value: string | null): void;
  (e: 'update:model', value: string | null): void;
  (e: 'refresh'): void;
}>();

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
</script>

<template>
  <NSpace :size="12" align="center" wrap>
    <NDatePicker
      type="daterange"
      :value="[props.range[0].valueOf(), props.range[1].valueOf()]"
      @update:value="onRange"
      clearable
      style="width: 320px"
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
    <NButton type="primary" @click="emit('refresh')">刷新</NButton>
  </NSpace>
</template>
