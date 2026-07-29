<script setup lang="ts">
import { h } from 'vue';
import { NDataTable, NText } from 'naive-ui';
import type { DataTableColumns } from 'naive-ui';
import type { UsageRecord } from '@/types';

const props = defineProps<{
  data: UsageRecord[];
  total: number;
  page: number;
  pageSize: number;
  loading: boolean;
}>();

const emit = defineEmits<{
  (e: 'update:page', value: number): void;
  (e: 'update:pageSize', value: number): void;
}>();

const columns: DataTableColumns<UsageRecord> = [
  { title: '时间', key: 'createdAt', width: 180, fixed: 'left' },
  { title: '提供商', key: 'provider', width: 160 },
  { title: '模型', key: 'model', width: 220 },
  { title: '项目', key: 'project', width: 160 },
  {
    title: '输入 Token',
    key: 'inputTokens',
    align: 'right',
    width: 120,
    render: (r) => r.inputTokens.toLocaleString(),
  },
  {
    title: '输出 Token',
    key: 'outputTokens',
    align: 'right',
    width: 120,
    render: (r) => r.outputTokens.toLocaleString(),
  },
  {
    title: '缓存读取',
    key: 'cacheReadTokens',
    align: 'right',
    width: 120,
    render: (r) => r.cacheReadTokens.toLocaleString(),
  },
  {
    title: '缓存写入',
    key: 'cacheWriteTokens',
    align: 'right',
    width: 120,
    render: (r) => r.cacheWriteTokens.toLocaleString(),
  },
  {
    title: '费用',
    key: 'cost',
    align: 'right',
    width: 100,
    render: (r) => (r.cost > 0 ? `$${r.cost.toFixed(4)}` : '-'),
  },
];

function rowClassName(_: number): string {
  return '';
}

function onPageChange(p: number) {
  emit('update:page', p);
}

function onPageSizeChange(s: number) {
  emit('update:pageSize', s);
}
</script>

<template>
  <NDataTable
    :columns="columns"
    :data="props.data"
    :loading="props.loading"
    :row-key="(r: UsageRecord) => `${r.createdAt}-${r.provider}-${r.model}`"
    :row-class-name="rowClassName"
    :pagination="{
      page: props.page,
      pageSize: props.pageSize,
      itemCount: props.total,
      showSizePicker: true,
      pageSizes: [20, 50, 100, 200],
      onUpdatePage: onPageChange,
      onUpdatePageSize: onPageSizeChange,
      prefix: () => h(NText, { depth: 3 }, () => `共 ${props.total} 条`),
    }"
    striped
    :bordered="false"
    size="small"
  />
</template>
