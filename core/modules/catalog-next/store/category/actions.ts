// import Vue from 'vue'
import { ActionTree } from 'vuex'
import * as types from './mutation-types'
import RootState from '@vue-storefront/core/types/RootState'
import CategoryState from './CategoryState'
import { quickSearchByQuery } from '@vue-storefront/core/lib/search'
import { buildFilterProductsQuery, isServer } from '@vue-storefront/core/helpers'
import { router } from '@vue-storefront/core/app'
import FilterVariant from '../../types/FilterVariant'
import { CategoryService } from '@vue-storefront/core/data-resolver'
import { changeFilterQuery } from '../../helpers/filterHelpers'
import { products, entities } from 'config'
import { configureProductAsync } from '@vue-storefront/core/modules/catalog/helpers'
import { DataResolver } from 'core/data-resolver/types/DataResolver';
import { Category } from '../../types/Category';
import { _prepareCategoryPathIds } from '../../helpers/categoryHelpers';
import { prefetchStockItems } from '../../helpers/cacheProductsHelper';
import { preConfigureProduct } from '@vue-storefront/core/modules/catalog/helpers/search'
import chunk from 'lodash-es/chunk'
import Product from 'core/modules/catalog/types/Product';
import omit from 'lodash-es/omit'
import config from 'config'

const actions: ActionTree<CategoryState, RootState> = {
  async loadCategoryProducts ({ commit, getters, dispatch, rootState }, { route, category } = {}) {
    const searchCategory = category || getters.getCategoryFrom(route.path) || {}
    const categoryMappedFilters = getters.getFiltersMap[searchCategory.id]
    const areFiltersInQuery = !!Object.keys(route[products.routerFiltersSource]).length
    if (!categoryMappedFilters && areFiltersInQuery) { // loading all filters only when some filters are currently chosen and category has no available filters yet
      await dispatch('loadCategoryFilters', searchCategory)
    }
    const searchQuery = getters.getCurrentFiltersFrom(route[products.routerFiltersSource])
    let filterQr = buildFilterProductsQuery(searchCategory, searchQuery.filters)
    const {items, perPage, start, total, aggregations} = await quickSearchByQuery({
      query: filterQr,
      sort: searchQuery.sort,
      includeFields: entities.productList.includeFields,
      excludeFields: entities.productList.excludeFields
    })
    await dispatch('loadAvailableFiltersFrom', {aggregations, category: searchCategory, filters: searchQuery.filters})
    commit(types.CATEGORY_SET_SEARCH_PRODUCTS_STATS, { perPage, start, total })
    const configuredProducts = await dispatch('processCategoryProducts', { products: items, filters: searchQuery.filters })
    commit(types.CATEGORY_SET_PRODUCTS, configuredProducts)

    return items
  },
  async loadMoreCategoryProducts ({ commit, getters, rootState, dispatch }) {
    const { perPage, start, total } = getters.getCategorySearchProductsStats
    if (start >= total || total < perPage) return

    const searchQuery = getters.getCurrentSearchQuery
    let filterQr = buildFilterProductsQuery(getters.getCurrentCategory, searchQuery.filters)
    const searchResult = await quickSearchByQuery({
      query: filterQr,
      sort: searchQuery.sort,
      start: start + perPage,
      size: perPage,
      includeFields: entities.productList.includeFields,
      excludeFields: entities.productList.excludeFields
    })
    commit(types.CATEGORY_SET_SEARCH_PRODUCTS_STATS, {
      perPage: searchResult.perPage,
      start: searchResult.start,
      total: searchResult.total
    })
    const configuredProducts = await dispatch('processCategoryProducts', { products: searchResult.items, filters: searchQuery.filters })
    commit(types.CATEGORY_ADD_PRODUCTS, configuredProducts)

    return searchResult.items
  },
  async cacheProducts ({ commit, getters, dispatch, rootState }, { route } = {}) {
    const searchCategory = getters.getCategoryFrom(route.path) || {}
    const searchQuery = getters.getCurrentFiltersFrom(route[products.routerFiltersSource])
    let filterQr = buildFilterProductsQuery(searchCategory, searchQuery.filters)

    const cachedProductsResponse = await dispatch('product/list', { // configure and calculateTaxes is being executed in the product/list - we don't need another call in here
      query: filterQr,
      sort: searchQuery.sort,
      updateState: false // not update the product listing - this request is only for caching
    }, { root: true })
    if (products.filterUnavailableVariants) { // prefetch the stock items
      const skus = prefetchStockItems(cachedProductsResponse, rootState.stock.cache)

      for (const chunkItem of chunk(skus, 15)) {
        dispatch('stock/list', { skus: chunkItem }, { root: true }) // store it in the cache
      }
    }
  },
  /**
   * Calculates products taxes
   * Registers URLs
   * Configures products
   */
  async processCategoryProducts ({ dispatch, rootState }, { products = [], filters = {} } = {}) {
    await dispatch('tax/calculateTaxes', { products: products }, { root: true })
    dispatch('registerCategoryProductsMapping', products) // we don't need to wait for this
    return dispatch('configureProducts', { products, filters })
  },
  /**
   * Configure configurable products to have first available options selected
   * so they can be added to cart/wishlist/compare without manual configuring
   */
  async configureProducts ({ rootState }, { products = [], filters = {} } = {}) {
    return products.map(product => {
      product = Object.assign({}, preConfigureProduct({ product, populateRequestCacheTags: config.server.useOutputCacheTagging }))
      const configuredProductVariant = configureProductAsync({rootState, state: {current_configuration: {}}}, {product, configuration: filters, selectDefaultVariant: false, fallbackToDefaultWhenNoAvailable: true, setProductErorrs: false})
      return Object.assign(product, omit(configuredProductVariant, ['visibility']))
    })
  },
  async registerCategoryProductsMapping ({ dispatch }, products = []) {
    await Promise.all(products.map(product => {
      const { url_path, sku, slug, type_id } = product
      return dispatch('url/registerMapping', {
        url: url_path,
        routeData: {
          params: { parentSku: product.sku, slug },
          'name': type_id + '-product'
        }
      }, { root: true })
    }))
  },
  async findCategories (context, categorySearchOptions: DataResolver.CategorySearchOptions): Promise<Category[]> {
    return CategoryService.getCategories(categorySearchOptions)
  },
  async loadCategories ({ commit, getters }, categorySearchOptions: DataResolver.CategorySearchOptions): Promise<Category[]> {
    const searchingByIds = categorySearchOptions && categorySearchOptions.filters && categorySearchOptions.filters.id
    const searchedIds: string[] = searchingByIds ? (categorySearchOptions.filters.id as string[]) : []
    if (searchingByIds) { // removing from search query already loaded categories
      categorySearchOptions.filters.id = searchedIds.filter(categoryId => !getters.getCategoriesMap[categoryId] && !getters.getNotFoundCategoryIds.includes(categoryId))
    }
    if (!searchingByIds || categorySearchOptions.filters.id.length) {
      const categories = await CategoryService.getCategories(categorySearchOptions)
      const notFoundCategories = searchedIds.filter(categoryId => !categories.some(cat => cat.id === parseInt(categoryId)))

      commit(types.CATEGORY_ADD_CATEGORIES, categories)
      commit(types.CATEGORY_ADD_NOT_FOUND_CATEGORY_IDS, notFoundCategories)
      return categories
    }
    return []
  },
  async loadCategory ({ commit }, categorySearchOptions: DataResolver.CategorySearchOptions): Promise<Category> {
    const categories: Category[] = await CategoryService.getCategories(categorySearchOptions)
    const category: Category = categories && categories.length ? categories[0] : null
    commit(types.CATEGORY_ADD_CATEGORY, category)
    return category
  },
  /**
   * Fetch and process filters from current category and sets them in available filters.
   */
  async loadCategoryFilters ({ dispatch, getters }, category) {
    const searchCategory = category || getters.getCurrentCategory
    let filterQr = buildFilterProductsQuery(searchCategory)
    const {aggregations} = await quickSearchByQuery({
      query: filterQr,
      size: config.products.maxFiltersQuerySize,
      excludeFields: ['*']
    })
    await dispatch('loadAvailableFiltersFrom', {aggregations, category})
  },
  async loadAvailableFiltersFrom ({ commit, getters }, {aggregations, category, filters = {}}) {
    const aggregationFilters = getters.getAvailableFiltersFrom(aggregations)
    const currentCategory = category || getters.getCurrentCategory
    const categoryMappedFilters = getters.getFiltersMap[currentCategory.id]
    let resultFilters = aggregationFilters
    const filtersKeys = Object.keys(filters)
    if (categoryMappedFilters && filtersKeys.length) {
      resultFilters = Object.assign({}, categoryMappedFilters, omit(aggregationFilters, filtersKeys))
    }
    commit(types.CATEGORY_SET_CATEGORY_FILTERS, {category, filters: resultFilters})
  },
  async switchSearchFilters ({ dispatch }, filterVariants: FilterVariant[] = []) {
    let currentQuery = router.currentRoute[products.routerFiltersSource]
    filterVariants.forEach(filterVariant => {
      currentQuery = changeFilterQuery({currentQuery, filterVariant})
    })
    await dispatch('changeRouterFilterParameters', currentQuery)
  },
  async resetSearchFilters ({dispatch}) {
    await dispatch('changeRouterFilterParameters', {})
  },
  async changeRouterFilterParameters (context, query) {
    router.push({[products.routerFiltersSource]: query})
  },
  async loadCategoryBreadcrumbs ({ dispatch, getters }, category: Category) {
    if (!category) return
    const categoryHierarchyIds = _prepareCategoryPathIds(category) // getters.getCategoriesHierarchyMap.find(categoryMapping => categoryMapping.includes(category.id))
    const categoryFilters = { 'id': categoryHierarchyIds }
    await dispatch('loadCategories', {filters: categoryFilters})
  }
}

export default actions