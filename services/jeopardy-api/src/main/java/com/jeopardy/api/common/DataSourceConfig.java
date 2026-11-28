package com.jeopardy.api.common;

import com.zaxxer.hikari.HikariConfig;
import com.zaxxer.hikari.HikariDataSource;
import java.util.Arrays;
import javax.sql.DataSource;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Primary;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.web.servlet.config.annotation.CorsRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

@Configuration
public class DataSourceConfig implements WebMvcConfigurer {

    private final String allowedOriginsCsv;

    public DataSourceConfig(
            @Value("${jeopardy.cors.allowed-origins:http://localhost:3000,http://localhost:5173}")
            String allowedOriginsCsv) {
        this.allowedOriginsCsv = allowedOriginsCsv;
    }

    @Bean(name = "postgresDataSource")
    @Primary
    public DataSource postgresDataSource(
            @Value("${jeopardy.datasources.postgres.url}") String url,
            @Value("${jeopardy.datasources.postgres.username}") String username,
            @Value("${jeopardy.datasources.postgres.password}") String password,
            @Value("${jeopardy.datasources.postgres.maximum-pool-size:15}") int maxPool) {
        HikariConfig cfg = new HikariConfig();
        cfg.setPoolName("jeopardy-postgres-pool");
        cfg.setJdbcUrl(url);
        cfg.setUsername(username);
        cfg.setPassword(password);
        cfg.setMaximumPoolSize(maxPool);
        cfg.setMinimumIdle(2);
        cfg.setConnectionTimeout(5000L);
        cfg.setMaxLifetime(1_800_000L);
        cfg.setIdleTimeout(300_000L);
        cfg.setKeepaliveTime(60_000L);
        cfg.setLeakDetectionThreshold(15_000L);
        cfg.addDataSourceProperty("connectTimeout", "5");
        cfg.addDataSourceProperty("socketTimeout", "10");
        return new HikariDataSource(cfg);
    }

    @Bean(name = "postgresJdbc")
    @Primary
    public NamedParameterJdbcTemplate postgresJdbc(
            @Qualifier("postgresDataSource") DataSource ds) {
        return new NamedParameterJdbcTemplate(ds);
    }

    @Bean(name = "clickhouseDataSource")
    public DataSource clickhouseDataSource(
            @Value("${jeopardy.datasources.clickhouse.url}") String url,
            @Value("${jeopardy.datasources.clickhouse.username}") String username,
            @Value("${jeopardy.datasources.clickhouse.password}") String password,
            @Value("${jeopardy.datasources.clickhouse.maximum-pool-size:10}") int maxPool) {
        String effectiveUrl = url != null ? url.trim() : "";
        effectiveUrl = appendQueryParamIfAbsent(effectiveUrl, "retry", "0");
        effectiveUrl = appendQueryParamIfAbsent(effectiveUrl, "failover", "0");
        effectiveUrl = appendQueryParamIfAbsent(effectiveUrl, "socket_timeout", "2500");
        effectiveUrl = appendQueryParamIfAbsent(effectiveUrl, "connect_timeout", "1500");
        effectiveUrl = appendQueryParamIfAbsent(effectiveUrl, "max_execution_time", "3");
        HikariConfig cfg = new HikariConfig();
        cfg.setPoolName("jeopardy-clickhouse-pool");
        cfg.setJdbcUrl(effectiveUrl);
        cfg.setUsername(username);
        cfg.setPassword(password);
        cfg.setMaximumPoolSize(maxPool);
        cfg.setMinimumIdle(1);
        cfg.setConnectionTimeout(1500L);
        cfg.setMaxLifetime(180_000L);
        cfg.setIdleTimeout(60_000L);
        cfg.setKeepaliveTime(45_000L);
        cfg.setInitializationFailTimeout(-1L);
        cfg.setConnectionTestQuery("SELECT 1");
        return new HikariDataSource(cfg);
    }

    private static String appendQueryParamIfAbsent(String url, String key, String value) {
        if (url.contains(key + "=")) {
            return url;
        }
        String separator = url.contains("?") ? "&" : "?";
        return url + separator + key + "=" + value;
    }

    @Bean(name = "clickhouseJdbc")
    public NamedParameterJdbcTemplate clickhouseJdbc(
            @Qualifier("clickhouseDataSource") DataSource ds) {
        return new NamedParameterJdbcTemplate(ds);
    }

    @Override
    public void addCorsMappings(CorsRegistry registry) {
        String[] origins = Arrays.stream((allowedOriginsCsv == null ? "" : allowedOriginsCsv).split(","))
                .map(String::trim)
                .filter(s -> !s.isEmpty())
                .toArray(String[]::new);
        if (origins.length == 0) {
            origins = new String[] {"http://localhost:3000", "http://localhost:5173"};
        }
        registry.addMapping("/api/**")
                .allowedOrigins(origins)
                .allowedMethods("GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS")
                .allowedHeaders("*")
                .allowCredentials(true);
    }
}
