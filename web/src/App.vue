<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { NConfigProvider, NMessageProvider, NSpin, NAlert, darkTheme, zhCN, dateZhCN } from 'naive-ui';
import SummaryCards from '@/components/SummaryCards.vue';
import DateRangePicker from '@/components/DateRangePicker.vue';
import UsageTable from '@/components/UsageTable.vue';
import PricingDialog from '@/components/PricingDialog.vue';
import { useUsage } from '@/composables/useUsage';
import type { Pricing } from '@/types';

const u = useUsage();

const pricingShow = ref(false);
const pricingProvider = ref('');
const pricingModel = ref('');

function onEditPricing(provider: string, model: string) {
  pricingProvider.value = provider;
  pricingModel.value = model;
  pricingShow.value = true;
}

function onSavePricing(p: Pricing) {
  u.savePricing(pricingProvider.value, pricingModel.value, p);
}

onMounted(() => {
  u.loadOptions();
  u.loadPricing();
});
</script>

<template>
  <NConfigProvider :theme="darkTheme" :locale="zhCN" :date-locale="dateZhCN">
    <NMessageProvider>
      <div class="root">
        <div class="header">
          <div class="header-bar">
            <h2 class="title">请求使用统计</h2>
            <DateRangePicker
              :range="u.range"
              :agent="u.agent"
              :provider="u.provider"
              :model="u.model"
              :agents="u.agents"
              :providers="u.providers"
              :models="u.models"
              @update:range="u.setRange"
              @update:agent="u.setAgent"
              @update:provider="u.setProvider"
              @update:model="u.setModel"
              @refresh="u.refresh"
            />
          </div>
        </div>
        <div class="body">
          <div v-if="u.error" class="error-wrap">
            <NAlert type="error" :title="u.error" closable @close="u.clearError" />
          </div>
          <div class="summary-wrap">
            <NSpin :show="u.summaryLoading && !u.summary">
              <SummaryCards :summary="u.summary" />
            </NSpin>
          </div>
          <UsageTable
            class="table-wrap"
            :reset-key="u.resetKey"
            :data="u.list"
            :total="u.total"
            :page="u.page"
            :page-size="u.pageSize"
            :loading="u.listLoading"
            @update:page="u.setPage"
            @update:page-size="u.setPageSize"
            @edit-pricing="onEditPricing"
          />
          <PricingDialog
            v-model:show="pricingShow"
            :provider="pricingProvider"
            :model="pricingModel"
            :pricing="u.pricingMap[`${pricingProvider}/${pricingModel}`]"
            @save="onSavePricing"
          />
        </div>
      </div>
    </NMessageProvider>
  </NConfigProvider>
</template>

<style>
html, body, #app {
  height: 100%;
  margin: 0;
  padding: 0;
}
#app {
  background: #101014;
  color: rgba(255, 255, 255, 0.82);
}
.root {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
}
.header {
  flex-shrink: 0;
  padding: 16px 24px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.09);
}
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
.body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 16px 24px;
  box-sizing: border-box;
}
.error-wrap {
  margin-bottom: 12px;
  flex-shrink: 0;
}
.summary-wrap {
  margin-bottom: 16px;
  min-height: 80px;
  flex-shrink: 0;
}
.table-wrap {
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
}
</style>
