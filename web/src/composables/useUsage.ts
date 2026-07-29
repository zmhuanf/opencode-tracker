import { computed, reactive, ref, watch } from 'vue';
import dayjs from 'dayjs';
import { api } from '@/api/client';
import type { Pricing, PricingMap, Summary, UsageRecord } from '@/types';

export interface UsageState {
  range: [dayjs.Dayjs, dayjs.Dayjs];
  provider: string | null;
  model: string | null;
  page: number;
  pageSize: number;
  list: UsageRecord[];
  summary: Summary | null;
  total: number;
  listLoading: boolean;
  summaryLoading: boolean;
  error: string | null;
  providers: string[];
  models: string[];
  pricingMap: PricingMap;
  resetKey: number;
  setPage(p: number): void;
  setPageSize(s: number): void;
  setRange(v: [dayjs.Dayjs, dayjs.Dayjs]): void;
  setProvider(v: string | null): void;
  setModel(v: string | null): void;
  clearError(): void;
  loadList(): Promise<void>;
  loadSummary(): Promise<void>;
  loadOptions(): Promise<void>;
  loadPricing(): Promise<void>;
  savePricing(provider: string, model: string, p: Pricing): Promise<void>;
  refresh(): Promise<void>;
}

export function useUsage(): UsageState {
  const state = reactive({
    range: [dayjs().startOf('day'), dayjs().endOf('day')] as [dayjs.Dayjs, dayjs.Dayjs],
    provider: null as string | null,
    model: null as string | null,
    page: 1,
    // 初始 50 兜底，UsageTable 挂载后用 ResizeObserver 覆盖成实际可显示行数
    pageSize: 50,
    list: [] as UsageRecord[],
    summary: null as Summary | null,
    total: 0,
    listLoading: false,
    summaryLoading: false,
    error: null as string | null,
    providers: [] as string[],
    models: [] as string[],
    pricingMap: {} as PricingMap,
  });

  const resetKey = ref(0);

  const filter = computed(() => ({
    start: state.range[0].valueOf(),
    end: state.range[1].valueOf(),
    provider: state.provider ?? '',
    model: state.model ?? '',
  }));

  const listQuery = computed(() => ({ ...filter.value, page: state.page, pageSize: state.pageSize }));

  async function loadList() {
    if (state.pageSize <= 0) return;
    state.listLoading = true;
    state.error = null;
    try {
      const resp = await api.usage(listQuery.value);
      state.list = resp.list;
      state.total = resp.total;
    } catch (e) {
      state.error = e instanceof Error ? e.message : String(e);
    } finally {
      state.listLoading = false;
    }
  }

  async function loadSummary() {
    state.summaryLoading = true;
    try {
      state.summary = await api.summary(filter.value);
    } catch (e) {
      state.error = e instanceof Error ? e.message : String(e);
    } finally {
      state.summaryLoading = false;
    }
  }

  async function loadOptions() {
    try {
      const [ps, ms] = await Promise.all([api.providers(), api.models()]);
      state.providers = ps;
      state.models = ms;
    } catch {
      // 选项加载失败不影响主表格
    }
  }

  async function loadPricing() {
    try {
      state.pricingMap = await api.pricing();
    } catch {
      // 定价加载失败不影响主流程
    }
  }

  async function savePricing(provider: string, model: string, p: Pricing) {
    const key = `${provider}/${model}`;
    await api.savePricing({ key, pricing: p });
    state.pricingMap = { ...state.pricingMap, [key]: p };
    await refresh();
  }

  function setPage(p: number) {
    state.page = p;
  }
  function setPageSize(s: number) {
    if (s > 0 && s !== state.pageSize) state.pageSize = s;
  }
  function setRange(v: [dayjs.Dayjs, dayjs.Dayjs]) {
    state.range = v;
  }
  function setProvider(v: string | null) {
    state.provider = v;
  }
  function setModel(v: string | null) {
    state.model = v;
  }
  function clearError() {
    state.error = null;
  }

  async function refresh() {
    await Promise.all([loadSummary(), loadList()]);
  }

  // 过滤条件变化时回到第一页，并触发 NDataTable 重置
  watch(filter, () => {
    state.page = 1;
    resetKey.value++;
  });

  // 过滤条件变化才重算 summary
  watch(filter, loadSummary, { deep: true, immediate: true });
  // 列表任意 query 变化都重新拉（pageSize 为 0 时早返，等 UsageTable 写入）
  watch(listQuery, loadList, { deep: true });

  return Object.assign(state, {
    resetKey: resetKey.value,
    get resetKeyRef() { return resetKey; },
    setPage, setPageSize, setRange, setProvider, setModel, clearError,
    loadList, loadSummary, loadOptions, loadPricing, savePricing, refresh,
  }) as unknown as UsageState;
}
