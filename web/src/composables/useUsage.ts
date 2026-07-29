import { computed, ref, watch } from 'vue';
import dayjs from 'dayjs';
import { api } from '@/api/client';
import type { Summary, UsageRecord } from '@/types';

const DEFAULT_PAGE_SIZE = 50;

export function useUsage() {
  const range = ref<[dayjs.Dayjs, dayjs.Dayjs]>([
    dayjs().subtract(30, 'day'),
    dayjs(),
  ]);
  const provider = ref<string | null>(null);
  const model = ref<string | null>(null);
  const page = ref(1);
  const pageSize = ref(DEFAULT_PAGE_SIZE);

  const list = ref<UsageRecord[]>([]);
  const summary = ref<Summary | null>(null);
  const total = ref(0);
  const loading = ref(false);
  const error = ref<string | null>(null);

  const providers = ref<string[]>([]);
  const models = ref<string[]>([]);

  const query = computed(() => ({
    start: range.value[0].format('YYYY-MM-DD'),
    end: range.value[1].format('YYYY-MM-DD'),
    provider: provider.value ?? '',
    model: model.value ?? '',
    page: page.value,
    pageSize: pageSize.value,
  }));

  async function refresh() {
    loading.value = true;
    error.value = null;
    try {
      const resp = await api.usage(query.value);
      list.value = resp.list;
      summary.value = resp.summary;
      total.value = resp.total;
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
    } finally {
      loading.value = false;
    }
  }

  async function loadOptions() {
    try {
      const [ps, ms] = await Promise.all([api.providers(), api.models()]);
      providers.value = ps;
      models.value = ms;
    } catch {
      // 选项加载失败不影响主表格
    }
  }

  // 过滤条件变化时回到第一页
  watch([range, provider, model], () => {
    page.value = 1;
  }, { deep: true });

  // 任何 query 变化都触发刷新
  watch(query, refresh, { deep: true, immediate: false });

  return {
    range,
    provider,
    model,
    page,
    pageSize,
    list,
    summary,
    total,
    loading,
    error,
    providers,
    models,
    refresh,
    loadOptions,
  };
}
