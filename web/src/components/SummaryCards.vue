<script setup lang="ts">
import { computed } from 'vue';
import { NCard, NStatistic, NSpace } from 'naive-ui';
import type { Summary } from '@/types';

const props = defineProps<{ summary: Summary | null; loading: boolean }>();

const items = computed(() => {
  const s = props.summary;
  if (!s) return [];
  return [
    { label: '总请求数', value: s.total.toLocaleString() },
    { label: '输入 Token', value: s.inputTokens.toLocaleString() },
    { label: '输出 Token', value: s.outputTokens.toLocaleString() },
    { label: '缓存读取', value: s.cacheRead.toLocaleString() },
    { label: '缓存写入', value: s.cacheWrite.toLocaleString() },
    { label: '缓存命中率', value: `${s.cacheHitRate.toFixed(2)}%` },
    { label: '费用 (USD)', value: `$${s.cost.toFixed(4)}` },
  ];
});
</script>

<template>
  <NSpace v-if="summary" :size="12" wrap>
    <NCard v-for="item in items" :key="item.label" size="small" :bordered="false" embedded>
      <NStatistic :label="item.label" :value="item.value" />
    </NCard>
  </NSpace>
</template>
