<script setup lang="ts">
import { computed, h, onBeforeUnmount, onMounted, ref } from 'vue';
import { NDataTable, NText, NButton } from 'naive-ui';
import type { DataTableColumns } from 'naive-ui';
import dayjs from 'dayjs';
import type { UsageRecord } from '@/types';

// 毫秒转秒，四舍五入取整
function formatDuration(ms: number): string {
  return Math.round(ms / 1000).toString();
}

const props = defineProps<{
  data: UsageRecord[];
  total: number;
  page: number;
  pageSize: number;
  loading: boolean;
  resetKey: number;
}>();

const emit = defineEmits<{
  (e: 'update:page', value: number): void;
  (e: 'update:pageSize', value: number): void;
  (e: 'editPricing', provider: string, model: string): void;
}>();

const columns: DataTableColumns<UsageRecord> = [
  {
    title: '时间',
    key: 'createdAt',
    width: 170,
    fixed: 'left',
    render: (r) => dayjs(r.createdAt).format('YYYY-MM-DD HH:mm:ss'),
  },
  {
    title: 'Agent',
    key: 'agent',
    width: 90,
    render: (r) => r.agent,
  },
  { title: '提供商', key: 'provider', width: 160 },
  {
    title: '模型',
    key: 'model',
    width: 220,
    render: (r) => h(NButton, { text: true, type: 'primary', onClick: () => emit('editPricing', r.provider, r.model) }, () => r.model),
  },
  {
    title: '总用时',
    key: 'durationMs',
    align: 'left',
    width: 80,
    className: 'metric-tight',
    render: (r) => (r.durationMs > 0 ? formatDuration(r.durationMs) : '-'),
  },
  {
    // 首字耗时：优先展示到首段可见文本，无文本时回落到首 token（含思考）
    title: '首字',
    key: 'firstTextMs',
    align: 'left',
    width: 80,
    className: 'metric-tight',
    render: (r) => {
      const ms = r.firstTextMs > 0 ? r.firstTextMs : r.firstTokenMs;
      return ms > 0 ? formatDuration(ms) : '-';
    },
  },
  {
    title: '速度',
    key: 'speed',
    align: 'left',
    width: 80,
    className: 'metric-gap',
    render: (r) => (r.speed > 0 ? Math.round(r.speed).toString() : '-'),
  },
  {
    title: '输入 Token',
    key: 'inputTokens',
    align: 'right',
    width: 110,
    render: (r) => r.inputTokens.toLocaleString(),
  },
  {
    title: '缓存读取',
    key: 'cacheReadTokens',
    align: 'right',
    width: 110,
    render: (r) => r.cacheReadTokens.toLocaleString(),
  },
  {
    title: '缓存命中率',
    key: 'cacheHitRate',
    align: 'right',
    width: 100,
    render: (r) => `${r.cacheHitRate.toFixed(2)}%`,
  },
  {
    title: '输出 Token',
    key: 'outputTokens',
    align: 'right',
    width: 110,
    render: (r) => r.outputTokens.toLocaleString(),
  },
  {
    title: '思考',
    key: 'reasoningTokens',
    align: 'right',
    width: 110,
    render: (r) => r.reasoningTokens.toLocaleString(),
  },
  {
    title: '缓存写入',
    key: 'cacheWriteTokens',
    align: 'right',
    width: 110,
    render: (r) => r.cacheWriteTokens.toLocaleString(),
  },
  {
    title: '费用',
    key: 'cost',
    align: 'right',
    width: 100,
    render: (r) => (r.cost > 0 ? `¥${r.cost.toFixed(3)}` : '-'),
  },
];

const containerRef = ref<HTMLElement | null>(null);
const maxHeight = ref(0);

// naive-ui small 模式行高（含 border）实测约 40px
const ROW_HEIGHT = 40;
const HEADER_HEIGHT = 36;
const PAGINATION_HEIGHT = 56;
const MIN_SIZE = 5;
const MAX_SIZE = 500;

function applyHeight(containerH: number) {
  if (containerH <= 0) return;
  const net = containerH - HEADER_HEIGHT - PAGINATION_HEIGHT;
  if (net <= 0) {
    maxHeight.value = Math.max(120, containerH - PAGINATION_HEIGHT);
    return;
  }
  const rows = Math.min(MAX_SIZE, Math.max(MIN_SIZE, Math.floor(net / ROW_HEIGHT)));
  // 实际占用 = 表头 + 行数 * 行高，设为 maxHeight 让 naive-ui 不产生内部滚动
  maxHeight.value = HEADER_HEIGHT + rows * ROW_HEIGHT;
  if (rows !== props.pageSize) emit('update:pageSize', rows);
}

function onPageChange(p: number) {
  emit('update:page', p);
}

const pageCount = computed(() => Math.max(1, Math.ceil(props.total / props.pageSize)));
const showPagination = computed(() => pageCount.value > 1);
const paginationConfig = computed(() => ({
  page: props.page,
  pageSize: props.pageSize,
  itemCount: props.total,
  showSizePicker: false,
  showQuickJumper: true,
  pageSlot: 7,
  onUpdatePage: onPageChange,
  prefix: () => h(NText, { depth: 3 }, () => `共 ${props.total} 条`),
}));

let resizeObserver: ResizeObserver | null = null;

onMounted(() => {
  const el = containerRef.value;
  if (el) {
    resizeObserver = new ResizeObserver((entries) => {
      const h = entries[0]?.contentRect.height ?? el.clientHeight;
      applyHeight(h);
    });
    resizeObserver.observe(el);
  }
  applyHeight(el?.clientHeight ?? window.innerHeight - 230);
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  resizeObserver = null;
});
</script>

<template>
  <div ref="containerRef" class="table-container">
    <NDataTable
      :key="props.resetKey"
      :columns="columns"
      :data="props.data"
      :loading="props.loading"
      :row-key="(r: UsageRecord) => `${r.agent}-${r.createdAt}-${r.provider}-${r.model}`"
      :max-height="maxHeight"
      remote
      striped
      :bordered="false"
      size="small"
      :pagination="showPagination ? paginationConfig : false"
    />
  </div>
</template>

<style scoped>
.table-container {
  width: 100%;
  height: 100%;
}
/* 总用时列贴近模型，收紧左 padding */
:deep(.metric-tight) {
  padding-left: 4px !important;
}
/* 速度列右侧留白，与输入 Token 拉开距离 */
:deep(.metric-gap) {
  padding-right: 28px !important;
}
</style>
