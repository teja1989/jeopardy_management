package com.jeopardy.api.common;

import com.zaxxer.hikari.HikariConfig;
import com.zaxxer.hikari.HikariDataSource;
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
        cfg.setConnectionTimeout(5000);
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
        HikariConfig cfg = new HikariConfig();
        cfg.setPoolName("jeopardy-clickhouse-pool");
        cfg.setJdbcUrl(url);
        cfg.setUsername(username);
        cfg.setPassword(password);
        cfg.setMaximumPoolSize(maxPool);
        cfg.setMinimumIdle(1);
        cfg.setConnectionTimeout(5000);
        cfg.setConnectionTestQuery("SELECT 1");
        return new HikariDataSource(cfg);
    }

    @Bean(name = "clickhouseJdbc")
    public NamedParameterJdbcTemplate clickhouseJdbc(
            @Qualifier("clickhouseDataSource") DataSource ds) {
        return new NamedParameterJdbcTemplate(ds);
    }

    @Override
    public void addCorsMappings(CorsRegistry registry) {
        registry.addMapping("/api/**")
                .allowedOriginPatterns("*")
                .allowedMethods("GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS")
                .allowedHeaders("*");
    }
}
