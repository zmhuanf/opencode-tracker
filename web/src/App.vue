<script setup lang="ts">
import { onMounted } from 'vue';
import {
  NConfigProvider, NLayout, NLayoutHeader, NLayoutContent,
  NMessageProvider, NSpin, NAlert, darkTheme, zhCN, dateZhCN,
} from 'naive-ui';
import SummaryCards from '@/components/SummaryCards.vue';
import DateRangePicker from '@/components/DateRangePicker.vue';
import UsageTable from '@/components/UsageTable.vue';
import { useUsage } from '@/composables/useUsage';

const u = useUsage();

onMounted(async () => {
  await u.loadOptions();
  await u.refresh();
});
</script>

<template>
  <NConfigProvider :theme="darkTheme" :locale="zhCN" :date-locale="dateZhCN">
    <NMessageProvider>
      <NLayout style="height: 100vh">
        <NLayoutHeader bordered style="padding: 16px 24px">
          <div class="header-bar">
            <h2 class="title">OpenCode TUI 请求使用统计</h2>
            <DateRangePicker
              :range="u.range.value"
              :provider="u.provider.value"
              :model="u.model.value"
              :providers="u.providers.value"
              :models="u.models.value"
              @update:range="(v) => (u.range.value = v)"
              @update:provider="(v) => (u.provider.value = v)"
              @update:model="(v) => (u.model.value = v)"
              @refresh="u.refresh"
            />
          </div>
        </NLayoutHeader>
        <NLayoutContent content-style="padding: 16px 24px">
          <div v-if="u.error.value" class="error-wrap">
            <NAlert type="error" :title="u.error.value" closable @close="u.error.value = null" />
          </div>
          <div class="summary-wrap">
            <NSpin :show="u.loading.value && !u.summary.value">
              <SummaryCards :summary="u.summary.value" :loading="u.loading.value" />
            </NSpin>
          </div>
          <UsageTable
            :data="u.list.value"
            :total="u.total.value"
            :page="u.page.value"
            :page-size="u.pageSize.value"
            :loading="u.loading.value"
            @update:page="(p) => (u.page.value = p)"
            @update:page-size="(s) => (u.pageSize.value = s)"
          />
        </NLayoutContent>
      </NLayout>
    </NMessageProvider>
  </NConfigProvider>
</template>

<style>
.header-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}
.title {
  margin: 0;
  font-size: 18px;
}
.error-wrap {
  margin-bottom: 12px;
}
.summary-wrap {
  margin-bottom: 16px;
  min-height: 80px;
}
</style>
