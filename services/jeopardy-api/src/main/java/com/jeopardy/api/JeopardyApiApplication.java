package com.jeopardy.api;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.scheduling.annotation.EnableScheduling;

@SpringBootApplication
@EnableScheduling
public class JeopardyApiApplication {

    public static void main(String[] args) {
        SpringApplication.run(JeopardyApiApplication.class, args);
    }
}
